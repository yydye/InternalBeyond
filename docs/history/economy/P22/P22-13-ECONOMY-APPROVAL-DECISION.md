# P22-13 · Economy Approval Decision Path

```text
基线      801d3c5  P22-12C · Economy Integration Closure Audit
本阶段     P22-13 · add Economy approval decision path
前置结论  docs/P22-12C-ECONOMY-INTEGRATION-CLOSURE.md §10.2 B1 ——
          decideApproval / resumeAgentPurchaseIntent / resumeApprovedPurchase
          三者在生产代码里的调用方 = 0，HTTP 写面 = 0，跨进程 command 面 = 0
本阶段只补  那一条**决定路径**，不补 UI、不补配置、不补 bootstrap
```

---

## §1 只读审计：这个仓库里已经有什么 user-authority seam

审计结论全部来自读代码，没有一条来自提示词假设。

### 1.1 已经有一份可复用的 transport，而且它是同一条

`services/home-node/http.js` 已经具备本阶段需要的每一条：

| 能力 | 位置 | 说明 |
|---|---|---|
| loopback 限制 | `isLoopback`（`http.js:456`） | 非 loopback 来源在路由之前整片拒绝 |
| 桌面凭据 | `authorized()`（`http.js:447`） | `X-IB-Home-Token` / `Authorization: Bearer` / `?token`，恒定时间比较 |
| 桌面面前缀守卫 | `isDesktopOnlyPath`（`http.js:597`） | `/internal/` 已在其中 ⇒ 远端未配置 token 时 403 `remote-admin-disabled` |
| Origin 授权 | `http.js:543-572` | 命名的外来 Origin 一律 403（防盲写） |
| 有界 body | `readBody(req, MAX_BODY_BYTES)` | 与既有写路径同款 |
| 信封与错误信封 | `ok()` / `bad()` / `sendJson()` | 结构化，不是裸字符串 |

⇒ 本阶段**不新造 transport，也不新造通用 Admin RPC / Action framework**。
新增的全部 HTTP 面就是**一条路径**。

### 1.2 缺的不是"能不能表达一次点头"，而是**可达性**

P22-12C §10.2 的 B1 逐字列出三件事，它们在本阶段之前同时为真：

```text
decideApproval                 economy-store.js:10670   生产调用方 = 0
resumeAgentPurchaseIntent      economy-store.js:12925   生产调用方 = 0
resumeApprovedPurchase         economy-capability.js:315 生产调用方 = 0
/economy/* 的 POST              http.js:1709            405 economy-is-read-only
/internal/economy/command       词表成员 = 1             resume 不在里面
```

而默认部署没有 autonomy policy ⇒ `AUTONOMY_DEFAULT_WHEN_NO_POLICY = REQUIRE_APPROVAL`
（`economy-contract.js`）⇒ 每一条 Agent Intent 都停在 `WAITING_APPROVAL`
（`economy-store.js:11826-11886`），**没有任何生产路径**能把它推到终态。

### 1.3 已有的 approval / confirmation 类交互

只有**读**面：`/economy/approvals`、`/economy/approval`（P22-7）。没有任何写面。
`http.js:976` 把 `/economy/approve` 与 `/economy/reject` 逐名留在 `unreachable` 里
—— 那是一个**声明**，而本阶段让它继续为真：新路径不在 `/economy/` 下。

### 1.4 审计的结论（决定本阶段形状的三句话）

1. **身份必须有自己的名字**。用户的点头/摇头在此之前没有任何 canonical
   consumer 可以承载它（见 §3.1）。这不是"再开一个消费者"，而是"让一条
   真实存在的路径拥有它自己的身份"。
2. **它必须经过门**。P22-9 §6 的纪律是"P22-8 的公开写面被**完整**覆盖"，
   而漏掉任何一条能到钱的路径都会让"唯一准入门"退化成一句声明。
   用户的决定**能**到钱（APPROVE → resume → settle），因此它必须在门里。
3. **决定与续做必须在同一个 handler 里**，而且顺序固定：先落一条 canonical
   决定，再用门给的句柄续做。把它们拆开就等于给出一条"没有用户决定也能
   resume"的路径 —— 那正是 P22-10 §9 拒绝开放 resume 的理由。

---

## §2 一条 authenticated 的用户决定（唯一入口）

```text
authenticated desktop user（UI / 诊断面）
      ↓  POST /internal/economy/approval-decision     ← 本阶段新增的全部 HTTP 面
 Approval Decision Seam（economy-approval-decision.js）
      ↓
 P22-7 store.decideApproval（APPROVED / REJECTED）
      ↓（**只有** APPROVE 才走这一步）
 P22-9 bound handle（consumer = user_decision_seam）
      ↓
 P22-8 resumeAgentPurchaseIntent
      ↓
 P22-6 → P22-3（既有权威链：预算终检 / 报价有效期 / 商品有效性 / 预留 / 结算）
```

### 2.1 这条路径**不是** `/internal/economy/command`

```text
/internal/economy/command            → Agent WANT（ECONOMY_PROPOSE_PURCHASE）
/internal/economy/approval-decision  → User APPROVAL DECISION（APPROVE / REJECT）
```

两条路径各有自己的准入、自己的凭据要求、自己的 consumer，而它们
**不共用任何一样**：

| | command 通道 | 决定 seam |
|---|---|---|
| consumer | `active_agent_runtime` | `user_decision_seam` |
| 凭据 | 每来源自己的 source token（+ 管道端口登记） | 已配置的桌面 token |
| 词表 | 恰好一个 command | 恰好两个决定词 |
| 能做什么 | 提出一条意图 | 对一条既有意图点头 / 摇头 |
| 能提出购买吗 | 能（那是它的全部） | **不能**（它的能力表里没有 PROPOSE_PURCHASE） |

`/security` 的 `economyPolicy.approvalDecision` 把
`sharesAConsumerWithTheCommandChannel` / `sharesACredentialWithTheCommandChannel`
写成恒 `false` 的字段（`http.js`），而 P22-13 的两个测试逐字断言它们。

### 2.2 信封恰好三个键

```text
{ approvalId, decision, idempotencyKey }
```

* `price` / `amountMinor` / `currency` / `budget` / `wallet` / `productId` /
  `settlementType` / `grantQuantity` / `consumerId` / `capability`
  **都不在**这封信封里 —— 出现即拒（`UNEXPECTED_ENVELOPE_KEYS`，400）。
  它们连"被忽略"的机会都没有。
* 决定词只有两个，而且**逐字引用** P22-7 的状态词
  （`DECISION.APPROVE = C.APPROVAL_STATE.APPROVED`）。
  `BUY` / `SETTLE` / `RESERVE` / `GRANT` / `REFUND` / `LEDGER` /
  `AUTO_ALLOW` / `FORCE_APPROVE` 在这份**代码里一次都不出现** ——
  它们不是被过滤，而是不在词表里（P22-13 的 B9 逐名断言源码）。

---

## §3 身份分离：Agent 是 proposer，用户是 approval authority

### 3.1 第四个消费者（本阶段唯一的契约改动）

```js
ECONOMY_CONSUMER.USER_DECISION_SEAM = 'user_decision_seam'
CONSUMER_RUNTIME_ANCHOR.user_decision_seam = 'services/home-node-service.js#economyAssembly'
CONSUMER_CAPABILITY_MATRIX.user_decision_seam = [RESUME_APPROVED_PURCHASE]
```

**为什么不能借用已有的三个**：

* `active_agent_runtime` —— 那正是**被决定**的一方。把用户的决定记在 Agent
  的身份下，等于让"Agent 自己批准自己"在审计里看不出来；
* `home_node_authority` —— P22-9 的 A5 逐字冻结了"权威不行动"（能力表为空），
  而它是**本进程自己的**身份；用储备在同一个进程里的身份去 resume，等于把
  "谁在决定"这个问题留在进程内部；
* `desktop_bridge` —— 它的运行时锚点是 Bridge 进程（另一个进程），而这条决定
  来自一个**已经过认证的桌面请求**，不是 Bridge 在做决定。

**为什么恰好一项能力**：它拿到的只有 `RESUME_APPROVED_PURCHASE`。
`PROPOSE_PURCHASE` **不在**它的表里 ⇒ "用户决定"无法被用来凭空发起一笔购买。

**锚点不变量被写宽一条，而不是放松**：第四个身份不是一个被 runner 拉起的
常驻组件，因此它的锚点是**装配点**（那一次 `bind(consumer)` 就是身份成形的
唯一位置）。契约新增 `isConsumerRuntimeAnchor(consumer, anchor)`，并且**同时
收严**了另一半：一个既不是组件锚点、也不是装配锚点的字符串现在会被当场拒绝
（在此之前任何非空串都能过）。载入期不变量与 P22-9 的 A3 都跟着改了。

### 3.2 身份**不是**一个参数

seam 里不存在 `decidedBy` 这个输入位。它在这一段代码里是一个字面量：

```js
const decider = Object.freeze({ type: C.PARTY_TYPE.USER, id: C.USER_PARTY_ID });
...
store.decideApproval({ approvalId, decision, decidedBy: { type: user.decider.type, id: user.decider.id }, idempotencyKey });
```

而 payload 里出现 `decidedBy` / `decidedById` / `by` / `decider` / `consumer` /
`consumerId` / `capability` / `role` / `authority` / `approved` / `autoAllow` /
`userId` / `user` / `agentId` / `party` 里**任何一个**都当场 403
（`NOT_ALLOWED_FOR_A_CALLER_TO_SELF_REPORT`），并且**不触碰** store。

### 3.3 Agent 结构性地不能自我批准 —— 四层，全部可证伪

| 层 | 事实 | 证伪方式 |
|---|---|---|
| ① | Agent 的句柄上**没有**决定能力 | `Object.keys(agentHandle)` 恰好五个，`decideApproval === undefined`（D1） |
| ② | seam 不接受自报身份 | 15 个身份键逐个 403 且 `reachedStore === false`（D2） |
| ③ | 用户身份不能填成 Agent | 即使绕过 seam，store 的 self-approval 闸门仍然拒绝：`the-buyer-cannot-approve-its-own-purchase`（D4） |
| ④ | 拿**来源凭据**来这条路径没有用 | 两条路径不共用凭据；无桌面凭据 ⇒ 外层 401 / seam 关闭（B9/B10/B12） |

第 ③ 层是 P22-7 已经写下的、本阶段一行未改的那条：`decidedBy` 必须是一个
canonical party，而它与 `buyer` 相同即拒。于是"Agent 自己批准自己"在**类型上**
不可表达，而不是靠一句约定。

---

## §4 APPROVE 只能走既有 resume 链

```text
APPROVE → decideApproval(APPROVED) → handle.resumeApprovedPurchase(...) → P22-8 → P22-6
```

### 4.1 "APPROVE → settlePurchase()"写不出来

seam 里**没有 store 这个对象**。装配层交给它的是一个**一个键的对象**：

```js
store: Object.freeze({ decideApproval: economyStore.decideApproval })
```

于是：

* 到 store 的边**恰好一条**（`store.decideApproval(...)`，字面成员名，一次）；
* 没有 `store[...]` 形式的计算型分派；
* `settlePurchase` / `preparePurchase` / `reserveFunds` / `mutateInventory` /
  `commitLedgerTransaction` / `putBudgetPolicy` / `putAutonomyPolicy` /
  `mintForSystem` / `createQuote` / `openWallet` / `expireApproval` 在这个文件里
  **一个都不出现**（B5 逐名断言源码）。

续做走的是 P22-9 门 bind 出来的句柄：

```js
resumeHandle.resumeApprovedPurchase({ approvalId, agentIntentId, idempotencyKey })
```

* 句柄的键恰好五个（`consumer` / `anchor` / `capabilities` /
  `proposePurchaseIntent` / `resumeApprovedPurchase`）—— 它**没有** settle；
* 本文件对句柄的访问也**恰好一次**字面成员调用，没有 `resumeHandle[...]`。

### 4.2 入参只有 canonical 事实

* `approvalId` —— 请求给的，已被 `isEconomyId('APPROVAL', …)` 校验；
* `agentIntentId` —— **不是**调用方给的，它来自 P22-7 那条批准行；
* `idempotencyKey` —— 派生出来的续做身份（见 §7）。

E 组用一个"记录每次调用"的探针句柄断言：`resume` 被调用**恰好一次**，
它的入参键恰好是 `['approvalId', 'idempotencyKey']`（加上 store 写下的
`agentIntentId`），没有任何经济事实。

### 4.3 P22-9 的 resume 能力没有"被偷偷打开"

`resumeApprovedPurchase` 在此之前**没有任何生产调用方**（P22-10 §9 明确
不开放 resume），而本阶段不是"把它开放了"，而是**给那条路径一个身份**：
`user_decision_seam` 的能力表里恰好一项，而它是这条路径唯一的持有者。
`economy-capability.js` 的公开面一行未改（六个成员 / 句柄五个键）。

---

## §5 REJECT 终止，且零经济动作

```text
PENDING → REJECTED（P22-7 的状态机写的）
之后：resume = 0 · ledger = 0 · inventory = 0 · settlement = 0
```

`REJECT` 分支里**没有**任何续做调用 —— 拒绝不是"再检查一遍然后不做"，
而是这条路径到此结束（连 `resumeApprovedPurchase` 那个成员名都不会被求值，
`reachedResumeHandle === false`）。返回值逐字带着：

```text
continuation: 'none'
continuationRefusedBecause: 'the-user-rejected-this-intent'
resumeAttempted: false        purchaseCreated: false
ledgerMutation: false         inventoryMutation: false
reservationMutation: false    settlementAttempted: false
```

F 组在一个真实 store 上断言：余额 / 预留 / 账目 / 库存 / 购买**一个都没动**，
报价仍然是 `OPEN`。而那条 intent 仍然是 `WAITING_APPROVAL`，直到下一次
（被拒的）恢复尝试把它终结成 `DENIED` —— 那是 P22-8 §7 已经写下的语义，
本阶段不改。

---

## §6 single-use / expiry / stale —— P22-7 是唯一权威

本阶段**不造第二套 Approval 状态机**。它不判断任何 status、不写任何 status：

| 情形 | 谁回答 | 结果 |
|---|---|---|
| APPROVED 只能消费一次 | P22-7 的 `consumeApprovalForPurchaseInTx` | 第一次购买把它推到 `CONSUMED` |
| CONSUMED 不能再次批准 | P22-7 的状态机 | `TRANSITION_NOT_ALLOWED` |
| 过期批准不能被批准 | `decideApproval` 在**写锁里**再比一次 `expires_at` | `APPROVAL_EXPIRED`，且**不**写决定 |
| REJECTED 不能复活 | P22-7 的终态 | `TRANSITION_NOT_ALLOWED` |
| 错误 intent / approval 配对 | P22-8 按 `approvalId` 定位（`selectPurchaseIntentByApproval`） | 回到**属于那份批准**的那条 intent；"批准还没决定" ⇒ `APPROVAL_REQUIRED` |
| 过期报价不因批准复活 | P22-6 的 preparePurchase 在写锁里比较 | `QUOTE_EXPIRED` → intent `FAILED` |
| 有效期过完不因批准复活 | 同上（批准的有效期**就是** intent 的有效期） | `APPROVAL_EXPIRED`，零经济动作 |

### 6.1 本阶段修掉的一个**真实缺陷**（开发期实测）

`resumeAgentPurchaseIntent` 的 `else if (o.approvalId != null)` 那一支写了
`db.prepare(SQL.selectPurchaseIntentByApproval)`，而那个常量**从来没有被定义过**：

```text
TypeError: The "sql" argument must be a string.
  at resumeAgentPurchaseIntent (economy-store.js:12944)
```

它一直没被发现，是因为在 P22-13 之前**每一次** resume 都带着 `agentIntentId`
（P22-8 的调用方手里就有那个 id），于是 `if` 那一支永远先命中，
`else if` 是一次**从未被执行过**的代码。本阶段补上那条语句：

```js
selectPurchaseIntentByApproval:
  'SELECT * FROM ' + PURCHASE_INTENTS_TABLE + ' WHERE approval_id=? ORDER BY created_at DESC, agent_intent_id DESC LIMIT 1'
```

修的是缺失的语句，而不是"让 seam 改传 agentIntentId"：按批准 id 定位是
P22-8 **自己声明**的能力（它的入参白名单里有 `approvalId`），一条声明与它
背后的实现必须同时为真。

---

## §7 Idempotency：两个身份，一层一个

| 身份 | 给谁 | scope | 语义 |
|---|---|---|---|
| `idempotencyKey`（请求给） | `decideApproval` | `APPROVAL_DECIDE` | 用户这一次"决定"的逻辑身份 |
| `'decision-resume:' + key`（派生） | `resumeApprovedPurchase` | `AGENT_INTENT_EXECUTE` | 同一次决定的**续做**身份 |

**为什么派生而不是复用**：那是两次 canonical mutation，各自有自己的 scope。
把同一个值同时当两个 scope 的 key，会让"这个 key 代表什么"在一个可被读到的
列里变成两个答案。

### 7.1 UI retry（response 丢失）收敛

```text
第一次：decideApproval 写决定 → resume 执行 → 购买成立
UI 没收到响应，重试同一个 key：
  · seam 的记忆：同一个身份 + 同一个决定词 ⇒ 放行
  · store 的决定：命中幂等记录 ⇒ replayed，返回当初那条 APPROVED
  · store 的续做：命中幂等记录 ⇒ replayed，返回当初那个结局
  · 结果：**同一笔购买**，世界逐字节不变
```

E8 / B8 逐字断言这一点（两次 `worldOf()` 深度相等、`purchases === 1`）。

### 7.2 同一个身份换决定词 ⇒ conflict

```text
APPROVE（key K，已成功）→ REJECT（key K）
  · seam 层：409 REQUEST_ID_CONFLICT（**在触碰 store 之前**）
  · 即使换一个新身份：P22-7 的终态闸门 ⇒ 409 TRANSITION_NOT_ALLOWED
```

E10 / E10b 断言这两道**独立**的闸门都在。只测其中一条会让另一条悄悄消失。

### 7.3 不产生第二笔 Purchase / 第二次 consumption / 第二次 Ledger mutation

本层**不缓存结果**（`seamAddsASecondPurchaseDedupe === false`）：重放时它仍然
真的走一遍门与 store，而收敛由 P22-8 / P22-6 的 canonical 幂等回答。
E9 断言重放时 `resume` 真的被又调用了一次，而 `purchases` 仍然是 1。

---

## §8 Approval ≠ guaranteed purchase

```text
APPROVED 只表示：用户允许这条 intent **继续尝试**。
```

它**不**保证购买成功。续做之后仍然要重新经过既有四道权威：

| 情形 | 结果 | 断言 |
|---|---|---|
| 预算终检拒绝（per-transaction 上限） | `ok:true`（决定落库）+ `continuation:'refused'` + `AMOUNT_EXCEEDS_PER_TRANSACTION` + intent `FAILED` + 零经济动作 | H1/H2/H3 |
| 报价已过期 | `ok:true` + `QUOTE_EXPIRED` + intent `FAILED` + 零经济动作 | H5/H6 |
| intent 有效期已过 | 决定本身被挡住（`APPROVAL_EXPIRED`，因为批准与 intent 同寿命） | H7/H7b |

于是 `APPROVED → resume → DENIED / FAILED` 是一条**合法**的结局，而返回值把它
写清楚：

```text
approvalDoesNotGuaranteeAPurchase: true
approvalIsNotAGuaranteedPurchase: true
budgetWasNotBypassed: true
quoteValidityWasNotBypassed: true
decisionIsNotAPurchaseGuarantee: true
```

H4 断言：在"批准了但没买成"之后重试同一次决定，决定重放、续做被拒，
而**不会**产生第二笔购买。

### 8.1 两个位，两个问题

开发期实测踩到的一个真实缺陷：这里一度只有 `purchaseCreated`，而它在重放时
是 `undefined` —— 于是"一次成功的购买"与"一次重放"在这个字段上看起来一样。

```text
purchaseCreatedNow   这一次调用**有没有**真的建出一笔购买？（重放 = false）
purchaseExists       这条 intent 现在**有没有**一笔购买？（重放 = true）
```

`purchaseExists` 在重放那条路上是从 `(intentId, state)` 推的
（`state === COMPLETED`）—— 那条推论**可靠**，因为每条 intent 的购买在结算
事务里与 `COMPLETED` 同一次写入（P22-6），且 `COMPLETED` 是终态。它是一个
推论，所以它写在注释里，而不是伪装成一次读。

---

## §9 生产入口：两条装配路径都挂着它

| 位置 | 事实 |
|---|---|
| `services/home-node-service.js` require | **只有**这一处（B15.2：目标集合一个成员都没变，条目数 8 → 10） |
| `economyAssembly` | `economyCapabilityGate.bind(economyApprovalDecisionModule.CONSUMER)` —— 全仓库**第二**次 `gate.bind(consumer)` |
| `buildHomeNode()` 返回值 | `economyApprovalDecision` |
| 进程级启动路径 | `economyApprovalDecision: economy.economyApprovalDecision` |
| `createHttp` deps | `economyApprovalDecision` |
| `/security` | `economyPolicy.approvalDecision` 一节（可断言字段） |

### 9.1 凭据：fail closed 到"整面关闭"

未配置桌面凭据（`IB_HOME_NODE_TOKEN` 空）⇒ `describe().open === false`，
每一次 dispatch 都在读 body **之前**返回 503 +
`ECONOMY_APPROVAL_DECISION_DESKTOP_TOKEN_NOT_CONFIGURED` +
`hint: 'set IB_HOME_NODE_TOKEN to enable the approval decision path'`。

这与 P22-11 的"未配置 source 凭据 ⇒ 通道关闭"逐字同源：**缺凭据就明说缺什么**，
而不是给一个永远失败的入口。默认部署因此需要那一个环境变量才能让 UI 点得动
—— 而这是一个**可执行的指路**，不是一句"被拒"。

### 9.2 用户身份的分量（不夸大）

```text
userIdentityStrength: 'authenticated-desktop-credential + loopback'
```

它回答的是"你有没有这台机器的桌面凭据"，它**不是** OS 沙箱，也不防
"同一个 Windows 用户下已经能读到那份配置的人"。这句话与 P22-11 的
`sourceIdentityStrength` 同源，而且是**返回值里**的一个字段。

---

## §10 公开面 / security 自述（机器可判定）

`/security` 的 `economyPolicy` 现在同时回答这五件事：

```text
httpVerbs: ['GET']                                   /economy/* 仍然只读
approvalDecision.approvalDecisionWritesExposed       open 时 = ['APPROVED','REJECTED']
approvalDecision.decisionWritesThatAreNotAPPROVEorREJECT  恒 []
approvalDecision.bypassesTheResumeChain             恒 false
approvalDecision.carriesEconomicFacts               恒 false
approvalDecision.sharesAConsumerWithTheCommandChannel   恒 false
approvalDecision.sharesACredentialWithTheCommandChannel 恒 false
commandChannel.commandWritesExposed                 仍然只有 ECONOMY_PROPOSE_PURCHASE
commandChannel.approvalWritesExposed / resumeWritesExposed / capabilityWritesExposed  仍然全空
```

★ 最后那一行是刻意的：**command 通道没有开放 resume**，而"用户决定"那条面
**不在它里面** —— 它是另一条路径。把两者合成一个字段会让"谁在决定"这个问题
失去答案。

### 10.1 与真实路由的一致性

`approvalDecision.path` 就是 seam 自己持有的那一个常量；`http.js` 里
**没有**写死那条路径的字面量（B20 断言：`/security` 声明的路径真的可达，
且返回的不是 404）。

---

## §11 本阶段**没有**做的事

```text
✗ Approval UI（modal / 按钮 / 通知）—— 留下一阶段，而且是它必须先有本阶段这条路径
✗ Store / Wallet / Inventory UI
✗ Bootstrap / Admin 配置面
✗ 普通 /economy/* 写 API（八条最自然的写形态仍然逐个 405）
✗ MCP Economy · Exchange · Refund · 真实 Provider quota · 真实支付
✗ 第二套 Approval 状态机 · 第三套购买 dedupe
✗ 通用 Admin RPC / Action framework
```

### 11.1 一处**契约最小修正**（§4 逐字允许的那一种）

P22-13 对已冻结的东西只动了三处，每一处都是为了表达一条**真实存在**的
关系，而不是为了让某个测试变绿：

1. 契约新增第四个消费者 + 它的锚点 + 矩阵里那**一项**能力（§3.1）；
2. 契约的锚点不变量从"必须指向 component-registry"改成"必须指向组件**或**
   装配点"，并**同时**拒绝第三种字符串（§3.1）；
3. store 补上那条从未被定义、也从未被执行过的 SQL 语句（§6.1）。

三处都写在这里，因为"契约改动"必须能被审计，而不是藏在 diff 里。

---

## §12 测试与进程纪律

```text
test_p22_13_economy_approval_decision.js   85 checks   单进程 · 零 child
test_p22_13_economy_approval_runtime.js    30 checks   真实 buildHomeNode + 真实 server + 真实 fetch · 零 child
```

```text
max concurrent child = 0 · total spawn = 0 · leftover = 0
```

**为什么一个 child 都不开**：§12 逐字要求"只有出现本阶段新增、必须跨进程
才能证明的身份 invariant 时，才允许最多 2 child"。本阶段没有这样的 invariant：

* 身份分离是**结构性**的（seam 里没有决定者参数、没有第二条到 store 的边、
  Agent 的句柄上没有决定能力）；
* single-use / 过期 / 冲突是 P22-7 的状态机，已在 P22-7 的两进程组里证明；
* 本阶段新增的东西是**一条 HTTP 路径**，而一条 HTTP 路径的真假只能由一个
  真实的、监听 socket 的 server 回答 —— server 起在**本进程**里就足够了
  （与 P22-11 的单进程组同款）。

也不重跑 P22-6 ~ P22-8 的 race/crash matrix（§12 逐字要求）。

### 12.1 回归

```text
P22 全量（31 个文件，含本阶段两个）     ran = 31 · failed = 0 · 148.7 s
services 侧相邻（home-node http/service/lan-gate/middle-brain/memory/moments）  全绿
test_frontend_structure.js（BOM/编码/结构）                                     全绿
```

### 12.2 上游阶段的断言：改的是什么，以及为什么

五个上游文件跟着改了断言，而每一处都不是"为了让测试变绿"：

| 文件 | 原断言 | 现在 | 为什么 |
|---|---|---|---|
| `test_p22_9_economy_capability.js` | consumers 恰好 3 个，锚点必须指向 component-registry | 4 个；锚点是组件**或**装配点 | §3.1：第四个身份不是常驻组件 |
| 同上 | 只有 active_agent_runtime 持有能力 | 只有它持有 **PROPOSE**；第四个持有 **RESUME** | 约束落在"谁能提议"这一件真正重要的事上 |
| `test_p22_1_economy_boundary.js` | 生产文件 5 个 / require 条目 8 / crypto 1 处 | 6 个 / 10 / 2 处 | 新增一个文件与一次**同一个用法**的 crypto |
| `test_p22_10_economy_action_adapter.js` | `gate.bind(Agent)` 全仓库恰好一次 | 那两个身份**各**恰好一次，且没有第三个 | 约束落在**身份**上，比次数更硬 |
| `test_p22_10_economy_active_runtime.js` | 装配层 require 恰好四个模块 | 五个 | 第五个是决定 seam |
| `test_p22_12_economy_active_plan.js` | economy-* 文件恰好五个 | 六个 | 封闭集合被显式承认了一次 |
| `test_p22_6_economy_purchase.js` | economy-* 文件恰好五个 | 六个 | 同上 |

★ 一处**已知**的红，而它不是回归：`tests/test_astra_readiness_observe.js` 的
`Z1.noProductionFileChanged` 断言"本阶段没有生产改动" —— 它在提交**之前**
必然为红，提交之后自然为绿。

---

## §13 留给下一阶段的**唯一**缺口

```text
用户点得动的那只手 —— MISSING
```

本阶段交付的是一条**真的可以调用的** production seam，而它现在的调用方是
测试。UI 仍然需要：

* 一条列出 `WAITING_APPROVAL` intent 的视图（读面已经全在：`/economy/intents`
  + `/economy/approval` + `/economy/intent?withChain=1`）；
* 两个按钮，各自带一个**稳定的** idempotency key（生成一次、重试复用）；
* 一个把 `continuation: 'refused'` 如实展示的地方 —— 因为 `APPROVED` 不等于
  购买成功（§8）。

⇒ 下一阶段：`P22-14 · Economy Approval UI`（本阶段不开始）。
