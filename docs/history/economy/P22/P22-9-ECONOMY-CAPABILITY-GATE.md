# P22-9 · Economy Capability Gate

冻结基线：`c3612cc`（P22-8 · add Agent Economy purchase intent bridge）
本阶段：`P22-9 · add Economy runtime capability gate`

---

## 1. 三句话

```text
Chat / Active Agent / Group / Voice / Diary / …（consumer）
                    ↓
           Economy Capability Gate          ← 本阶段（唯一、确定性、fail closed）
                    ↓
          proposeAgentPurchaseIntent()      ← P22-8（门是它唯一的调用方）
                    ↓
      P22-8 Intent → P22-7 Autonomy/Approval → P22-6 Purchase/Settlement
```

三句话，而它们绝不合并：

| 层 | 回答的问题 | 输入 |
|---|---|---|
| **Capability**（本阶段） | 这个 consumer 有没有资格**开口**？ | consumer 是谁、它要哪个 capability |
| **Authority**（P22-7） | Economy 允不允许这个 Agent **直接买**？ | 余额、预算、商品、限额、策略 |
| **Settlement**（P22-6） | 这笔钱**怎么动**？ | 报价快照、预留、账本事务 |

一次 `CAPABILITY_GRANTED` 的意思**只有**"你有资格问"。它**不是** `AUTO_ALLOW`、
**不是** Budget ALLOW、**不是** Approval granted、**不是** Purchase allowed。

---

## 2. §1 的只读审计：consumer matrix

### 2.1 审计怎么做的

只读确认，不凭提示词假设：

```text
① 全仓库扫 economy / Economy：生产 JS 只有 4 个文件命中
     services/home-node/economy-store.js      228 处
     services/home-node/http.js               206 处
     services/home-node/economy-contract.js   155 处
     services/home-node-service.js             40 处
   （assets/js/** 命中 0 —— 浏览器侧对经济域零引用）

② P22-8 的写入口在全仓库的调用点：
     .proposeAgentPurchaseIntent( / .resumeAgentPurchaseIntent(
   → 生产代码里 **0 处**；只有 tests/ 与 tests/fixtures/p22-8-intent-worker.js

③ 谁在 Node 里真的跑 JS：runtime/component-registry.js 登记的六个组件
     static · bridge · active · homeNode · restart · vision
   其中只有三个进程可能持有 canonical Economy store 的引用
```

### 2.2 实际 consumer matrix

| consumer id | 运行时锚点（可核对） | 是什么 | PROPOSE_PURCHASE | RESUME_APPROVED_PURCHASE |
|---|---|---|---|---|
| `active_agent_runtime` | `component-registry.js#active` | IB Active 的调度器与 Moments companion —— Node 里**唯一**一个"Agent 自己决定要不要动手"的运行时（它的计划来自模型，而计划必须过 `sanitizeAiPlan` 的封闭动作集 `['schedule','none','cancel_existing']`） | **ALLOW** | **ALLOW** |
| `home_node_authority` | `component-registry.js#homeNode` | canonical 权威进程本身。它**服务**经济事实（http.js 的只读面），但它不是一个会自己做决定的 agent | DENY | DENY |
| `desktop_bridge` | `component-registry.js#bridge` | 模型 / 工具网络面。整条链上离外部网络最近的一环；它的经济引用数在审计里是 0 | DENY | DENY |

**"权威不行动"**：`home_node_authority` 的能力列表是空的，而这不是"暂时还没配"。

### 2.3 审计**否掉**的那些界面（缺席清单）

它们是 `CAPABILITY_SURFACES_NOT_PRESENT`，一份**有内容**的回答，而不是一个待补的空白：

| surface | 为什么不是消费者 |
|---|---|
| `chat` | 浏览器侧编排（`assets/js/chat-core.js`）；到 store 的通道只有 HTTP，而 HTTP 经济写面为 0 |
| `group_chat` | 浏览器侧编排（`assets/js/communication.js`） |
| `voice` | 浏览器侧音频工作单元（`assets/js/voice-worklet.js`）；与经济域零引用 |
| `active_diary` | 浏览器侧时间线渲染（`assets/js/active-diary.js`），不是提议发起者 |
| `moments_ui` | canonical Moments 的**读面**在浏览器；Node 侧的 companion 属于 `active_agent_runtime` |
| `mcp_client` | §8：本阶段不接 MCP |
| `llm` | 模型输出**不是**一个消费者：它连身份都没有，因此它无法成为矩阵里的键 |

任何一天有人把 `consumer: 'chat'` 传进来，得到的答案是一个有名有姓的
`UNKNOWN_CONSUMER`，而不是一句"未知消费者"。

---

## 3. §2 门的形状

### 3.1 判定：契约里的纯函数

```js
C.checkEconomyCapability({ consumer, capability })
// → { decision: 'CAPABILITY_GRANTED' | 'CAPABILITY_DENIED',
//     granted, consumer, capability, reasonCode, capabilities,
//     revokedCapabilities,
//     isEconomyAuthority:false, isBudgetDecision:false, isAutonomyDecision:false,
//     isApproval:false, isPurchasePermission:false, authorizesSpending:false,
//     bypassesBudget:false, errors }
```

它是**纯函数**：不读时钟、不读随机、不写任何东西、不 require 任何模块。
权限矩阵（`CONSUMER_CAPABILITY_MATRIX`）是唯一真源，载入期不变量断言
矩阵与判定器**逐字一致**。

### 3.2 执行：`bind(consumer)` —— consumer 与 capability **都不是参数**

```js
const handle = gate.bind('active_agent_runtime');   // 构造期绑定身份
handle.proposePurchaseIntent({ proposal, idempotencyKey });
handle.resumeApprovedPurchase({ agentIntentId, approvalId, idempotencyKey });
```

★ 这两个方法**没有** consumer 参数，也**没有** capability 参数。capability 绑在
**方法名**上（`proposePurchaseIntent` / `resumeApprovedPurchase`），consumer 绑在
**构造期**。

这不是"校验身份"，而是"**没有那个输入位**"——与本仓库会话治理的既有做法同源。
一个模型无论输出什么，都只能填 `proposal` 的内容（而 `proposal` 自己的六键白名单
在 P22-8 里）；它连"我是谁"和"我要什么能力"这两个位置都不存在。

### 3.3 为什么 RESUME 这一项**不能省**

P22-8 的公开写面有**两个**动词。只给 `propose` 加门，`resumeAgentPurchaseIntent`
就成了一条旁路 —— 而那条旁路走完同样会让钱动（批准之后继续同一条 intent → P22-6
结算）。门的完备性只由"公开写面被完整覆盖"决定，不由"哪个动词更常被调用"决定。

### 3.4 §6：句柄上**没有**的东西

句柄是冻结的，键恰好五个：

```text
consumer · anchor · capabilities · proposePurchaseIntent · resumeApprovedPurchase
```

它不持有 store（`handle.store === undefined`）、原型就是 `Object.prototype`，而且
`settlePurchase / preparePurchase / reserveFunds / commitReservation /
mutateInventory / grantInventory / consumeInventory / decideApproval /
authorizePurchaseIntent / createApprovalRequest / mintForSystem /
commitLedgerTransaction / executeEconomyAction / runAction / buyNow /
approveForAgent` 全部 `undefined`。

★ 而且**刻意没有** `executeEconomyAction(method, args)` 这种万能入口：门对 store 的
访问全部是**字面成员名**，源码里没有 `store[…]` 形式的计算型分派（B18.4 断言）。
"用一个字符串换任意底层能力"在这段代码里不存在，而不是"不推荐"。

---

## 4. §3 Fail closed：六类理由

| reasonCode | 触发的输入 |
|---|---|
| `MISSING_CONSUMER` | `consumer` 缺失 / `null` / 空串 / 纯空白 |
| `UNKNOWN_CONSUMER` | consumer 不在闭集里（`'gpt'`、`'active'`、`'homeNode'`、`'ACTIVE_AGENT_RUNTIME'`、`42`、`{}`） |
| `MISSING_CAPABILITY` | `capability` 缺失 / `null` / 空串 |
| `UNKNOWN_CAPABILITY` | capability 不在闭集里（`'BUY_NOW'`、`'propose_purchase'`） |
| `CAPABILITY_REVOKED` | 这台节点**收回**了它（`config.revokedCapabilities`） |
| `CONFIGURATION_CORRUPT` | 配置不是纯对象 / 含未识别的键 / `revokedCapabilities` 不是数组 / 含未知能力 |

三条结构性决定：

1. **拒绝的顺序**是：配置 → 身份 → 能力。一份损坏的配置让其余答案都不可信；
   而一个连自己是谁都说不清的调用方，不该先收到"这个能力不存在"——那会把一次
   **身份**问题伪装成一次**能力**问题，两者的处置方式相反。
2. **没有同义词提升**（与 §6 的 `promotePartyRef` 相反）：consumer id 是**身份**，
   不是类别。`'active'` ≠ `'active_agent_runtime'`，`'homeNode'` ≠
   `'home_node_authority'`。允许提升就等于允许调用方用近义词猜身份。
3. **配置只能收窄**。唯一合法的配置形状是 `{ revokedCapabilities: [capability…] }`。
   任何别的键（`grants` / `allow` / `matrix` / `bypass`）都是**一次提权企图**，它
   表现为 `CONFIGURATION_CORRUPT` 而不是被静默忽略——静默忽略会让"我明明配了"与
   "配置根本没生效"看起来完全一样。

而权限**不来自**：LLM output · prompt · Memory · Relationship · reason · 聊天文本 ·
Middle Brain 自行判断。这不是一句纪律，是一个结构：**那七个位在 `checkEconomyCapability`
的每一个返回分支里都存在且恒为 false**（A10 对六个分支逐个断言）。

---

## 5. §4 没有旁路：三种证据

```text
     consumer → Capability Gate → proposePurchaseIntent        ✔
     consumer → proposePurchaseIntent                          ✘
```

| # | 证据 | 位置 |
|---|---|---|
| ① | **全仓库调用点断言**：生产代码（services / active / runtime / assets/js / bridge / scripts）里出现 `.proposeAgentPurchaseIntent(` 或 `.resumeAgentPurchaseIntent(` 的地方**恰好两处**，都在 `economy-capability.js` 里 | B18.3 / B18.3b（永久边界断言） |
| ② | **句柄没有那个输入位**（§3.2）：调用方无处可传身份与能力；多传的键不被转发，只被**列出来**（`ignoredInputKeys`） | C11 / C3 |
| ③ | **拒绝路径证明**：被拒的 consumer 拿到的是一个"一被调用就抛错"的 store，因此"拒绝路径碰了 store"会以异常形式炸掉，而不是静静地看起来通过 | C6 / C7 / C8 / C9 / C10 |

★ 测试**直接**调用 store 是允许且必要的（P22-6 ~ P22-8 的 canonical 行为必须在
"没有门"的情况下也能被独立证明，那些阶段的测试就是这么写的）。被禁止的是
**生产代码**里的旁路。

**门的位置**：`economy-store.js` 里没有任何 consumer / capability 的判定；
`economy-contract.js` 里只有词表与纯函数；**执行**只有 `economy-capability.js` 一处。
P22-6 ~ P22-8 的 canonical ownership 一行未改 —— `proposeAgentPurchaseIntent` 与
`resumeAgentPurchaseIntent` 的源码逐字不变（K6 与 B18.3b 都在断言这件事的两半）。

---

## 6. §5 Capability ≠ Economy authority

即使 `PROPOSE_PURCHASE = CAPABILITY_GRANTED`，后面仍完整经过
`P22-8 Intent → P22-7 Autonomy/Approval → P22-6 Purchase/Budget/Settlement`。
三组**行为**证据（不只是字段）：

| check | 场景 | 结果 |
|---|---|---|
| D1 | 门准了 + 商品不存在 | P22-8 以 `PRODUCT_NOT_FOUND` 拒绝，零 intent |
| D2 | 门准了 + 权威说 `REQUIRE_APPROVAL` | 停在 `WAITING_APPROVAL`，`reservedNothing:true`、`purchaseCreated:false`、0 笔 Purchase |
| D3 | 门准了 + 权威说 `AUTO_ALLOW`，但**预算**说不 | Intent `FAILED`，余额 `100000` 逐字不变，0 笔 Purchase |
| D4 | 那条 intent 的 `approvalId` | 由**运行时**创建（`econ_approval_…`），不是门给的 |

★ 另外两处让误读在**字形上**不可能：

```text
CAPABILITY_DECISION = { CAPABILITY_GRANTED, CAPABILITY_DENIED }
AP_DECISION        = { AUTO_ALLOW, REQUIRE_APPROVAL, DENY }
                     交集 = ∅        （载入期不变量 + A6）
CAPABILITY_DENY_REASONS ∩ DENY_REASONS = ∅   （载入期不变量 + A7）
```

如果准入决定也叫 `DENY`，那么 `decision === 'DENY'` 在审计里就有两个可能的意思，
而"能力不是权威"会退化成一个注释。

---

## 7. §7 审计：只记有业务意义的 linkage

### 7.1 写什么、不写什么

| 事件 | 写 change log 吗 |
|---|---|
| 一次纯能力检查（`checkEconomyCapability` / `gate.check…`） | **不写**。500 次 × 2 组合的断言证明行数不变（E1） |
| 一次**被拒**的提议 | 写**恰好**一行 `DENIED`，`agentIntentId: null`（E2） |
| 一次被授权、并且真的走到了一条 intent 的提议 | 写一行 `GRANTED`，`agentIntentId` = 那条 intent（E3） |
| 幂等重放（同一个 `idempotencyKey`） | 不写（E4） |
| §10 去重窗口内的重复（不同 key、同一意图） | 不写（E5） |

★ 这一条与 P22-8 的幂等/去重是**互补**的：重复的模型输出最多产生一条 intent，
而最多产生一行授权审计。

### 7.2 §7 的四问在一行里可答

`ECONOMY_CAPABILITY_DECIDED` 的 payload（15 个键，白名单）：

```json
{ "domain": "ib.economy",
  "consumerId": "active_agent_runtime",
  "capability": "PROPOSE_PURCHASE",
  "decision": "CAPABILITY_GRANTED",
  "reasonCode": null,
  "agentIntentId": "econ_agentintent_…",
  "runtimeAnchor": "runtime/component-registry.js#active",
  "capabilityIsNotEconomyAuthority": true,
  "capabilityDecisionIsNotABudgetDecision": true,
  "ledgerMutation": false, "inventoryMutation": false,
  "providerMutation": false, "paymentMutation": false,
  "memoryMutation": false, "relationshipMutation": false }
```

→ 哪个 consumer 提出的、它请求了什么 capability、门是 GRANTED 还是 DENIED、
最终对应哪条 Agent Intent。四个答案一行。

`entity_id` 指向这次决定**关于**的那件事：有 intent 时是那条 intent，没有时
（一次被拒的提议）是提出请求的 consumer。

### 7.3 伪造一行审计在结构上不成立

`store.appendCapabilityAudit()` 会**重新校验**它被要求写下的 consumer 与 capability
（用的是契约那一个 `makeCapabilityAuditRecord`）：

```text
{ consumerId: 'gpt', … }                     → ok:false  consumer-not-canonical
decision: 'AUTO_ALLOW'                       → ok:false  decision-not-in-closed-set
DENIED 却不带拒绝理由                          → ok:false  denied-must-carry-a-deny-reason
GRANTED 却带着拒绝理由                         → ok:false  granted-must-not-carry-a-deny-reason
```

如果那里只是 `String(o.consumerId)`，那么"consumer 身份不得来自模型输出"就退化成了
一句注释。

### 7.4 ★ 一条诚实的限制

**未知 consumer 的拒绝写不进 canonical change log** —— 那里只接受 canonical 身份
（这正是上面那条不可伪造性的代价）。因此那条路径上：

```text
result.auditRecorded === false
result.auditFailure   === 'capability-audit-rejected:capability-audit-consumer-not-canonical'
```

它被**如实带出去**（E7 断言），并另有一路运行时日志（`econ.capability.decided`）。
这里不假装记下了。

---

## 8. §8 HTTP / Provider / Payment 边界不变

| 边界 | 状态 | 证据 |
|---|---|---|
| HTTP Economy writes | **0** | 六条"授权形态"的路径 × POST/PUT/DELETE 全部 405；GET 也不存在（门连读面都不对外） |
| 24 次 HTTP 尝试之后 | 经济事实**逐字未变** | intent 数与 change log 行数都不动（B4） |
| `/security` 把它写成可断言字段 | ✔ | `capabilityGateImplemented:true`、`capabilityWritesExposed:[]`、`capabilityReadsExposed:[]`、`capabilityGrantViaHttpIsForbidden:true`、`capabilityIsNotEconomyAuthority:true`、`capabilityIsNotABudgetDecision:true` |
| `unreachable` 名单 | ✔ | `/economy/capability`、`/economy/capabilities`、`/economy/capability/grant`、`/economy/capability/revoke`、`/economy/gate`、`/economy/gate/check` |
| Provider mutation | **0** | 门不 require 任何 provider/凭据模块；审计记录六位全 false |
| Payment | **0** | 同上 |
| network | **0** | 门只 require `./economy-contract.js`（B18.1/B18.6） |
| Memory / Relationship mutation | **0** | 同上 |
| Middle Brain | **零改动** | `services/home-node/middle-brain.js` 未被本阶段触碰 |
| MCP | 不接 | §8 |

★ 门**刻意没有**任何 HTTP 面：它是同进程的装配事实，不是一项服务。一个"读矩阵"
的路由会让读者以为矩阵是一项可以**协商**的东西。

---

## 9. §9 进程与资源硬限制（逐条回答）

### 9.1 测试策略

```text
优先：单进程 → 多 SQLite connection → worker/fixture → 最后才是真实子进程
```

本阶段的选择是**最上面那一档**：全部单进程。

### 9.2 硬数字

```text
P22-9 最大同时 child process 数   0
总 spawn 次数                     0
是否存在遗留 child                 否（没有任何 child 可遗留）
每个 child 加载的主要模块          不适用（没有 child）
峰值 RSS                          未测量（§9：不要为了测 RSS 引入监控系统）
```

两个测试文件**都**在末尾自报这三行，并且它们自己就是证据：

| 文件 | 断言 |
|---|---|
| `test_p22_9_economy_capability.js` | G1：本进程 `require.cache` 里**没有** `child_process` / `net` / `http` / `https` / `tls` / `dgram` / `worker_threads` |
| `test_p22_9_economy_runtime.js` | R2：`require.cache` 里没有 `child_process`（它确实加载了 `http`/`net` —— 那是**被**测的 HTTP 服务，不是子进程宿主） |

它们加载的模块（§9 要求的"最小 fixture dependency closure"）：

```text
capability 文件:  economy-contract · economy-store · economy-capability   （+ node:fs/os/path）
runtime 文件:     home-node-service · http · economy-{contract,store,capability} · chat-store
```

★ **没有**启动：完整 Desktop · Electron · 浏览器 · Playwright · 完整 DSH · 完整 IB UI。
runtime 文件的 HTTP 是真实的（真实 socket、真实 handler），但 server 起在**本进程**里
—— 与 `test_p22_2_economy_runtime.js` 的 in-process 组同款。

### 9.3 为什么**一个**子进程都不需要（而不是"最多两个"）

§9 说"真实多进程测试只保留证明 process boundary 必须存在的少数场景"，§11 说
"最多一个必要的双进程 boundary test"。本阶段的答案是 **0**，理由是可证的而不是
省事的：

1. 门是**纯查表 + 一次调用**：它没有跨进程状态（B18.7 断言顶层没有 `let`/`var`），
   也不 require 任何进程/网络原语（B18.6）。
2. 门的全部自有 invariant 都是**单进程可判定**的（见 §11 的映射表）。
3. 门参与的唯一跨进程性质是"同一个提议在两个真实进程里恰好产生一条 intent"，
   而那属于 P22-8 的 store —— 已经在 `tests/fixtures/p22-8-intent-worker.js` 的
   两进程组里被证明过。§10 逐字要求不要在 P22-9 重做。
4. 拒绝路径不需要并发：它连 store 都不碰（用一个会抛错的 store 证伪，比开第二个
   进程强得多）。

### 9.4 生命周期

两个文件都不用 `process.exit(0)`（那会掩盖未释放的 handle）。它们：

```text
关掉每一个 store / server（R1 / R1）
删掉每一个一次性临时目录（R1 / R1）
把 process.exitCode 设成 0 或 1，然后**自然退出**
```

没有 detached child，没有 `Promise.all` 的大量 spawn，没有无上限 worker pool ——
因为没有 spawn。

---

## 10. §10 不重复旧阶段的重型并发测试

旧阶段已经证明过、本阶段**只做正常 regression 复跑**的：

```text
Ledger atomicity · Approval race · Purchase race · Intent crash recovery · multi-process exactly-once
```

P22-9 的 23 个 P22 测试文件里，P22-1 ~ P22-8 的全部 21 个是**原样复跑**（其中两个文件
的"生产文件清单"断言按既有机制登记了第三个文件 —— 见 §13）。P22-9 的新测试里没有
`process.abort()`、没有 20 组崩溃矩阵、没有两进程竞争组。

### 10.1 观察到的一个负载敏感 flake（如实记录）

在**并行**跑整套 static 组时（`test-all.js --quick`），旧阶段的两个多进程竞态见证项
各出现过一次失败：

| 文件 | 失败的 check | 单独复跑 |
|---|---|---|
| `test_p22_7_economy_runtime.js` | E0/E1（两个 worker 同时动手，一个 exit 1、无 stderr） | 连续 3 次通过；整包复跑通过 |
| `test_p22_8_economy_runtime.js` | D6a（*(kept for the record)* 两个见证人各自的读数 —— 一个读到 `COMPLETED`、另一个读到 `EXECUTING`） | 连续 2 次通过 |

判据不是"重跑就好了"，而是依赖闭包：那两个 worker 只 `require` `economy-store.js`
（+ `node:path` / `node:sqlite`），**不加载** `home-node-service.js`；而本阶段对
`economy-store.js` 的改动是**纯加法**（`+66 / −0`：一个新函数 + 一行导出），对
`economy-contract.js` 的改动同样只是新增 §25 与一条事件类型。因此进程竞争窗口的形状
没有被改动过，而两个失败都出现在整包并行、机器负载高的时候（Windows 上被超时杀掉的
子进程正是"exit 1 且没有 stderr"）。

---

## 11. §11 测试

```text
tests/test_p22_9_economy_capability.js   65 checks（单进程，0 spawn）
tests/test_p22_9_economy_runtime.js      19 checks（真实装配 + in-process HTTP，0 spawn）
```

§11 点名要覆盖的每一项与它的 check：

| §11 要求 | check |
|---|---|
| known allow | C1 · A5 · A4 |
| known deny | C6（desktop_bridge）· C7（home_node_authority） |
| unknown consumer | C8 · B5 · A8 |
| missing identity | C9 · B1–B4 |
| unknown capability | B9 · B10 |
| **bypass guard** | **B18.3**（全仓库调用点）· C11 · C3 · B18.4 |
| LLM cannot forge consumer/capability | **C11**（`consumerId`/`capability`/`approved`/`autoAllow` 被忽略并列出）· A8（近义词不认）· E6（伪造审计写不进去） |
| allowed proposal still hits P22-7 | D2 · D3 · D4 · D6 |
| denied proposal creates no Quote/Purchase/Ledger mutation | C6–C10（poisoned store）· E2（`agentIntentId:null`） |
| restart | F1–F4 |
| 最多一个必要的双进程 boundary test | **0 个**（§9.3 的四条理由） |
| HTTP GET-only | B1 · B2 · B3 · B4 · B5 · B6 |
| isolation | 每个组一次性临时目录 + 独立 store；结尾 R1 断言目录已删 |

单进程内**不**用并发冒充"更狠的单进程测试"：`node:sqlite` 的 `DatabaseSync` 是同步
API，单线程里两次 propose 不可能交错 —— 那件事只能由两个真实进程证伪，而它属于
P22-8。

登记：`tests/test-all.js` 的 static 组尾部新增两条。

---

## 12. §12 未进入（本阶段刻意不做）

```text
通用 Action 集成       MCP Economy tool      UI / 素材
Exchange               Refund                Provider quota        真实支付
```

以及两件**刻意**留在门外的：

* **门没有 HTTP 面**（连读面都没有）—— §8。
* **门不接 MCP**：外部工具没有任何经济能力 —— §8。

---

## 13. 已知限制（诚实记录）

1. **门是进程内的一层，不是操作系统沙箱。** 它做到的是：consumer 拿到的句柄
   **没有**身份参数、**没有** capability 参数、**没有**底层动词；而"没有任何生产代码
   绕过它"由一次全仓库调用点断言（B18.3）保证。任何能拿到 `buildHomeNode()` 返回值或
   `require` 到 store 的代码**在进程内**仍然可以直接调用 store —— 这是既有架构的
   事实（P22-2 起 store 就在同进程 API 上），本阶段没有把它变成不可能；它把
   "绕过"从一句自觉变成一次会让边界测试变红的改动。
2. **未知 consumer 的拒绝写不进 canonical change log**（§7.4）。
3. **`CONFIGURATION_CORRUPT` 的触发面只有"收窄配置"这一个入口**：本阶段没有引入
   任何持久化的准入配置（那是通用 RBAC 的第一步，§2 明确禁止）。因此它的现实触发
   条件是装配层传了一个错形状的 `economyCapabilityConfig`。
4. **`active_agent_runtime` 今天还没有真的提议过购买**：它是唯一被授予能力的消费者，
   而接线（"调度器真的去提议")不在本阶段范围里。本阶段证明的是：**当它接线时，它
   必须经过门**，而且门已经在那里了。
5. **生产文件从两个变成三个**。这是本阶段唯一一次"多一个文件"，理由写在
   `test_p22_1_economy_boundary.js` 的 `PRODUCTION_FILES` 里（"门必须长在 P22-8 的
   上面"）。依赖闭包**没有**变宽：新文件 require 的仍是那份已有的契约。
