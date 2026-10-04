# P21-R4-C-LIVE-3.3 · Server Recall Boundary Contract

> 状态：**Server Recall Boundary = READY**（Desktop cutover **未实现**）
> HEAD `209c990b76ac12cb66049fbb2807b66648ec275c` · 本阶段不 commit、不 push
> 关联：`docs/P21-R4-C-LIVE-EXECUTION-BOUNDARY.md`（Runtime Interpretation 边界）

---

## 1 · 术语（冻结，更正 LIVE-3.1 的过窄措辞）

```
SERVER_RECALL_AUTHORITY_SLICE = FULL_RECALL_SELECTION_PIPELINE
```
包含：canonical read · visibility · query · channel/gate · ranking/fatigue ·
cooldown · session state · seats · exploration · final IDs · turn identity。

**不含**：渲染、prompt 组装、provider/model 调用、Interpretation。
上一轮写的 `MINIMUM_SERVER_AUTHORITY_SLICE = SELECTION_STAGE_ONLY` **作废**
（它会让维护者以为"只迁最后 top-K"）。

---

## 2 · 边界面

```
POST /internal/runtime/memory-recall      （唯一一条运行时召回面 · desktop-only）
```
* 落在 `/internal/` 前缀 ⇒ 继承 `isDesktopOnlyPath` 与既有桌面凭据判定；**无豁免**。
* 非 POST ⇒ 405 `runtime-recall-is-post-only`。
* 服务未装配 ⇒ 该分支不存在 ⇒ 通用 404（与解释边界同一约定）。
* **不新增**第二个 recall engine：唯一一次调用
  `services/home-node/memory-retrieval.js#retrieve()`（它自己再委托共享 orchestrator）。

---

## 3 · 请求契约（闭集，8 键）

| 字段 | 必需 | authority |
|---|---|---|
| `operation` | ✓ | 必须为 `'memory-recall'`，否则 403 `operation-forbidden` |
| `characterId` | ✓ | caller 声明**主体**；服务端由此解析 runtime spec（权威仍在服务端） |
| `requestId` | ✓ | caller 提供的**本回合**标识，参与 turn identity |
| `conversationId` | ✓ | 同上 |
| `message` | ✓ | **原始** turn 文本；服务端自行跑 query parser / hard gate / relevance |
| `isFirstTurn` | – | 原始 turn signal（供 coldStart 通道） |
| `conversationSignalAvailable` | – | 同上 |
| `timeoutMs` | – | 可传；服务端 clamp；缺席取服务端默认 |

### 拒绝（逐名，绝不静默忽略）
* `caller-attempted-to-supply-recall-authority`（400，带 `field`）：
  `selectedIds` `candidateRecords` `records` `candidates` `scores` `rank` `ordering`
  `topK` `budget` `maxChars` `contentLen` `seatPlan` `seats` `exploration`
  `allowExploration` `cooldown` `cooldownFactor` `sessionState` `turnIndex`
  `random` `rng` `now` `timestamp` `activation` `activationPolicy` `settings`
  `normalizedQuery` `tokens` `query` `glossaryEntries` `glossaryProvider`
  `getGlossaryEntries`
* `request-field-forbidden`（400）：其余未知键（闭集）。
* 其他：`request-shape-invalid`(400) · `runtime-spec-unavailable`(404) ·
  `recall-unavailable`(503) · `recall-timeout`(504)。

---

## 4 · 权威表（冻结）

```
RECALL_BUDGET_AUTHORITY   = SERVER_RUNTIME      （浏览器不得传 budget / topK / seat count）
RECALL_QUERY_AUTHORITY    = SERVER_RUNTIME      （浏览器只传原始 turn signal）
RECALL_RANDOM_AUTHORITY   = SERVER_RUNTIME      （探索抽样由服务端 RNG；测试可注入）
RECALL_CLOCK_AUTHORITY    = SERVER_RUNTIME      （now 由服务端 clock；测试可注入）
RECALL_CHANNEL_AUTHORITY  = SERVER_RUNTIME      （本路由**不**传 channel hint，通道由既有 turn signal 决定并**如实回报**）
RECALL_SELECTION_AUTHORITY = CALLER_PROPOSED    （**未变**：cutover 未实现）
```

### 4.1 `includeHeader` —— header 属于**选择预算语义**，不是纯 presentation
机械依据：紧预算（`maxChars=200`）下 header 会**改变最终 selected set**，不只是 chars。
因此选择阶段两侧统一采用**生产 header 策略**（两侧 `includeHeader:true`）；
mobile 路径默认 `false` **逐字节不变**（选项显式化，默认保持既有行为）。
未来若两侧都变成 ids-only 消费者，再一起改 `false` —— 那需要改桌面 wrapper。

```
SERVER_RUNTIME_RECALL_INCLUDE_HEADER = TRUE
    （冻结理由：保持当前 Desktop selection semantics parity —— 服务端召回边界
      必须复现桌面 wrapper 的选择预算语义，否则紧预算下 selected set 不同。）

IDS_ONLY_SELECTION_HEADER_POLICY = UNRESOLVED    ← 未来 debt，已登记
    （一个只消费 ids 的消费者其实不该为 header 预留预算；
      但两侧一起改成 false 需要改桌面 wrapper，而它是用户 dirty 文件。
      本轮**不碰**，留待 cutover 阶段与桌面侧一起改。）
```

### 4.2 glossary provider seam
两侧 wrapper 现在**都**转发调用方的 `glossaryProvider` / `getGlossaryEntries`，
由 orchestrator 里**同一份** `resolveGlossaryCatalog` + `glossary-catalog` 工厂解析。
provider **只由装配层注入**，**绝不**从 request 取；生产今天**两侧都没有来源** ⇒ 通道 dormant。

### 4.3 session cooldown
边界以**只读**方式取 `sessionState.currentTurnIndex({characterId})` 作为 turn index
（`turnIndexAuthority = 'SERVER_SESSION_STATE_READ_ONLY'`）。
★ 诚实边界：服务端计数器今天只由 Home-Node-owned 回合（mobile）推进，
**会话所有权未转移**；因此桌面影子比较只有在两侧**同索引**时才有意义。
无 sessionState 注入时 index 为 null ⇒ cooldown **inert**（显式标注，不隐藏）。

---

## 5 · 纯影子（Pure Shadow）

边界**只读**：不写 exposure、不推进 session state、不激活记忆、不调用 provider、
不改动任何 sqlite 字节。`boundary` 块自述：`pureShadow:true` / `exposureWrites:0` /
`activationWrites:0` / `providerCalls:0` / `sessionMutation:'NONE'` / `attempts:1`。

---

## 6 · Recall Result Object（供未来 Interpretation 直接消费）

成功信封（**恰好 14 键**）：
```
{ ok, durable:false, operation, characterId, turnIdentity, selectedIds[],
  activationPolicy, channel, reason, fingerprint,
  counts:{ candidates, eligible, selected }, chars, boundary, status }
```
* `turnIdentity = { requestId, conversationId, messageChars, messageHash }`
  （`messageHash` 用仓库既有 `stableToken`，**不含原文**；重放稳定）。
* 计数映射（冻结）：`candidates ← diagnostics.counts.input`，
  `eligible ← diagnostics.counts.gated`，`selected ← selectedIds.length`。
* 有界诊断来自 wrapper 的显式 opt-in（`withTrace:true`）：只取
  `mode / channel / earlyExit / earlyExitReason / counts / budget`，
  **绝不**带出 `trace.candidates[]`（逐条分数）。
* **不含**：hidden candidates、逐条分数、canonical 整行、full-view 诊断。

```
INTERPRETATION_CAN_CONSUME_SERVER_RECALL_RESULT = STRUCTURALLY_READY
```
（结构就绪；本阶段**不**调用 Interpretation，production gate 仍 DISABLED。）

---

## 7 · Ticket 决策（本轮）

```
RECALL_RESULT_CAPABILITY_TICKET = NOT_IMPLEMENTED
```
理由：未来最干净的路径是 **server recall → 直接内部调用 interpretation service**，
不该为了假设中的跨步骤触发而先引入 crypto/token 机制。
若将来浏览器**必须**跨步骤触发，再补 capability；届时其语义必须是
"服务端**先算出**结果再签票"，与本仓库已拒绝的"caller 给 ids 再签票"不同。

---

## 8 · 所有权（**未转移**）

```
CURRENT_EXPOSURE_OWNERSHIP = SPLIT_BROWSER_AND_HOME_NODE   （未变）
TARGET_EXPOSURE_OWNERSHIP  = HOME_NODE                     （目标，写进契约）
BROWSER_RECALL_AUTHORITY   = PRODUCTION                    （未变：cutover 未实现）
```
`assets/js/communication.js` 的 exposure writer **未停**、`assets/js/memory.js` **未改**
（均为用户 dirty 文件）。

---

## 9 · Activation turn guard（硬 gate 已补）

`memory-store.js#recordActivation(ids, { turnId })`：
同一 `(turnId, memoryId)` 最多一次 canonical 自增；重复调用返回
`{ ok:true, updated:0, duplicated:[…], reason:'turn-duplicate' }`（**可读的 no-op**，不是错误）。
`turnId` 缺席 ⇒ **不去重**（legacy 调用方逐字节不变）。

```
ACTIVATION_GUARD_A_SAME_TURN_SAME_MEMORY        = +1
ACTIVATION_GUARD_B_EXACT_REPLAY                 = +0
ACTIVATION_GUARD_C_NEW_TURN_SAME_MEMORY         = +1   （**不做**全局幂等）
ACTIVATION_GUARD_D_SAME_TURN_DIFFERENT_MEMORIES = 各 +1
GUARD_DURABILITY = IN_MEMORY_ONLY（每次 open() 清空；无 schema、无迁移、无 durable 表）
RESTART_REPLAY_INCREMENTS_AGAIN = YES                  （**如实记录**：重启后重放旧回合会再自增）
```

### 9.1 冻结语义（contract / tests / report **逐字一致**，P21-R4-LIVE-3.3.1）
```
ACTIVATION_TURN_GUARD            = IN_PROCESS_TURN_SCOPED
SAME_PROCESS_SAME_TURN_DUPLICATE = NO_INCREMENT
DIFFERENT_TURN                   = INCREMENT_ALLOWED
CROSS_PROCESS_RESTART_GUARANTEE  = NONE
CROSS_RESTART_EXACTLY_ONCE       = NO
ACTIVATION_AUTO_RETRY            = NONE
```
⚠ **措辞纪律**：本仓库**不得**出现无范围限定的 "exactly-once activation"。
守卫覆盖的只有"**同一进程内、同一 turn、同一 memory**"这一格；
跨进程重启**没有任何保证**（`CROSS_PROCESS_RESTART_GUARANTEE = NONE`）。
`tests/test_r4c_live_recall_boundary_closure.js` §7.F 是这条的**机械测试**
（process A: turn X + memory M ⇒ +1；restart；process B: 同 X 同 M ⇒ **再次 +1**），
它断言的是**已知契约**，不是 regression。
分层：同进程 + 同 requestId ⇒ gateway duplicate 短路；同进程 + 同 turnId ⇒ 本 guard +0；
**重启后两者都不保护**（gateway 的 `turnByRequest` 同样是内存 Map）。
R2-H 语义未改：selection 可在 activation 失败时照常返回；
definite failure 不本地猜 bump；ambiguous 保持 canonical unknown 且**不重试**。

---

## 10 · 本阶段**未**做（边界就绪 ≠ 已切换）

* Desktop selection/exposure/session 所有权**未移交**；
* `communication.js` exposure writer **未停**；
* Interpretation production gate **未开**（`R4C_PRODUCTION_EXECUTION = DISABLED`）；
* 没有 3.3 之前遗留的 cutover 前置项之外的任何新依赖；
* Expectation / R4-F **未开始**（`R4_F_LIVE_MEDIATOR_REQUIREMENT = L3_AND_L5`，未变）。
