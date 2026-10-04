# P21-R4-C-LIVE-RECALL-BOUNDARY · Server Recall Boundary Contract

> 状态：**P21-R4-LIVE-3.4 · Desktop Recall Authority Cutover = COMPLETE**
> （边界已就绪 **且** Desktop 生产召回权威已切换到 Home Node）
> 本阶段不 commit、不 push。
> 关联：`docs/P21-R4-C-LIVE-EXECUTION-BOUNDARY.md`（Runtime Interpretation 边界）

```
SERVER_RECALL_BOUNDARY_READY        = YES
DESKTOP_RECALL_CUTOVER              = COMPLETE
RECALL_SELECTION_AUTHORITY          = SERVER
    （范围：**Desktop 对话回合** —— 单聊 + 群聊。非对话的系统生成路径见 §11.4，
      它们被显式分类为 B 且保持浏览器选择，不构成"第二个权威入口"。）
DESKTOP_RECALL_SESSION_STATE_OWNER  = HOME_NODE
DESKTOP_RECALL_EXPOSURE_OWNER       = HOME_NODE
ACTIVATION_AUTHORITY                = HOME_NODE
BROWSER_RECALL                      = DISABLED_FOR_PRODUCTION_DESKTOP_TURN
                                      （引擎仍在：memory.js 未改，保留回滚与诊断能力）
BROWSER_RECALL_ENGINE               = PRESENT_FOR_ROLLBACK_AND_DIAGNOSTICS
R4C_PRODUCTION_EXECUTION            = DISABLED（本轮**未**开启）
R4_F_LIVE_MEDIATOR_REQUIREMENT      = L3_AND_L5（未变）· R4-F_AUTHORIZED = NO
```

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

## 10 · P21-R4-LIVE-3.4 · Desktop Recall Authority Cutover（本轮）

### 10.1 请求新增 `mode`（闭集第 9/10 键）
```
mode = 'shadow' | 'authoritative'   · 缺席 ⇒ 'shadow' · 其他值 ⇒ request-shape-invalid(400)
isGroup = true|false                · 群聊回合声明（映射到引擎的 isGroup/groupMemEnabled）
```
`mode` 是**能力声明**，不是数据权威 —— 它不在 `REJECTED_AUTHORITY_FIELDS` 里。
· `'shadow'`：与 3.3 逐字节相同（**恰好 14 键**、`boundary.pureShadow === true`、零写入）。
· `'authoritative'`：**恰好 16 键** = 14 + `context` + `effects`；`boundary.mode='authoritative'`、`pureShadow=false`。
  `context = { text, count, chars, includeHeader:true }`（共享 core 已渲染、已过可见性的有界块，**不是**新渲染器）；
  `effects = { turnBegun, activation:{updated,duplicated,reason}, exposure:{written}, turnEnded }`。

### 10.2 Authority lifecycle（复用既有机器，不造第二套）
`beginHomeTurn → retrieve → reinforce（canonical activation）→ recordExposure → endHomeTurn`，
与 mobile gateway 同形（`mobile-gateway.js:2500/2558/2583/2597`）。
```
DESKTOP_RECALL_SESSION_STATE_OWNER = HOME_NODE
DESKTOP_RECALL_EXPOSURE_OWNER      = HOME_NODE
ACTIVATION_AUTHORITY               = HOME_NODE
```

### 10.3 Prompt context authority（§10 裁决 = 方案 A）
服务端在 authoritative 模式下**直接返回有界授权上下文**（`context.text`），
浏览器**原样注入**：`_memCtx = result.context`。
浏览器**不做** ID→mirror 查找、不重排、不替换、不补选、不重新打分 ——
因为**这条路径上根本没有浏览器选择入参**（见 §10.4）。stale mirror 因此不可能影响选择。

### 10.4 Consumption seam（唯一的召回入口）
`assets/js/communication.js` 中的 `ibRecallContextForTurn(input)`，由
`/* === P21-R4-LIVE-3.4 · CUTOVER CONSUMPTION SEAM === */` 界定。
```
入参：{ characterId, message, isGroup, requestId, conversationId,
        isFirstTurn?, conversationSignalAvailable?, turn?, serverRecall?, timeoutMs? }
出参：{ context, selectedIds, authority:'SERVER'|'SERVER_UNAVAILABLE', browserFallback:false }
```
★ **没有 browserSelect / legacySelect 入参** —— 浏览器选择**无从进入**这条路径（强于"接受但不咨询"）。
成功时在 turn 对象上打 `_ibRecallAuthority = 'SERVER'`，两处浏览器 exposure 写入据此跳过。
```
BROWSER_RECALL_AFTER_CUTOVER = DISABLED（生产 Desktop 对话回合）
```
（§9 的 A/B 二选一里选 **B**：不保留浏览器 diagnostic shadow。理由：seam 已无选择入参，
保留"影子选择"就必须重新引入浏览器选择器，反而把刚切掉的权威又请回来；§18/§19 因此不适用。）

### 10.5 Identity（复用既有事实源，未新造任何 id）
```
requestId      = 既有的每回合 _turn.turnId（communication.js:3072，
                 _seqCore.turnIdFor(userMsg.id) = 'turn_' + stableToken(seed)，确定性、无时钟无随机）
conversationId = 既有的 canonical 派生 _ibConvId(friendId,threadId)（chat-core.conversationIdOf）
NEW_PERMANENT_ID_REQUIRED = NO
```
两者由 `buildChatContext` 调用点注入（单聊 + 群聊各一处），group 侧用 `typeof _mbTurn!=='undefined'` 守卫：
取不到 ⇒ `''` ⇒ 服务端 shape 拒绝 ⇒ 该轮**没有**记忆（fail-closed，绝不退回浏览器选择）。

### 10.6 失败语义与超时（冻结）
```
SERVER_RECALL_FAILURE_RESTORES_BROWSER_AUTHORITY = NO
FAILURE_BEHAVIOR      = 该轮没有记忆上下文，**聊天照常继续**（不阻塞、不回落浏览器权威）
RECALL_WAIT_TIMEOUT_MS    = 2500   （客户端外层兜底，绝不无限阻塞 first token）
RECALL_REQUEST_TIMEOUT_MS = 2000   （传给服务端的内层界；**不是** Interpretation 的 120s）
```
这不是 hybrid authority：`RECALL_SELECTION_AUTHORITY = SERVER` 要么真、要么这一轮没有记忆，
**不存在**"服务端不在就浏览器接管"的第三条路。

### 10.7 Replay
同一 `(requestId, conversationId, message)`：选择不重新探索、session 不推进、exposure 不重复、
activation 不重复；**不同 requestId = 新回合**，正常执行一次。
传输层内部重试复用**同一个** `_turn`/turnId ⇒ 同一逻辑回合，不产生第二次。

### 10.8 First-token 成本（如实记录）
服务端召回归前置于主模型请求，因此 loopback HTTP hop **进入 first-token 关键路径**。
实测值见最终报告 §O；**不是零成本**。诊断值，不设硬阈值。

### 10.9 Activation 的诚实边界（未因 cutover 升级）
```
ACTIVATION_TURN_GUARD           = IN_PROCESS_TURN_SCOPED
SAME_PROCESS_SAME_TURN_DUPLICATE= NO_INCREMENT
DIFFERENT_TURN                  = INCREMENT_ALLOWED
CROSS_PROCESS_RESTART_GUARANTEE = NONE
CROSS_RESTART_EXACTLY_ONCE      = NO
ACTIVATION_AUTO_RETRY           = NONE
```
restart 之后重放旧回合仍可能再次自增 —— **已知契约，不是 regression**。

### 10.10 非对话路径（B 类，显式不在 cutover 范围）
`RECALL_SELECTION_AUTHORITY = SERVER` 的范围是**Desktop 对话回合**（单聊 + 群聊）。
以下路径经机械审计分类为 **B（不是用户对话召回路径）**，仍走浏览器选择；
它们的存在**不构成**"第二个浏览器权威入口"：

| 路径 | 位置 | 为什么是 B |
|---|---|---|
| 日志自动留言 | `communication.js:59` | 后台系统生成，无 conversation/turn 身份 |
| 标注 annotations | `communication.js:141` | 同上 |
| 信件 letters | `communication.js:259` | 同上 |
| memory one-line | `memory.js:1114` | 诊断/摘要行，不注入对话 prompt |
| role↔role DM | `role-dm.js:565` | 角色对角色，用户不是参与者 |
| transport retry | `callApiChatStream` 内 | 复用同一 `_turn`/turnId，同一逻辑回合 |
| XML 工具续轮 / MB organize / 主动日记 | — | 不自行 retrieval 或不经 canonical recall |

**C 类（明确另一套权威）**：Auto Memory 注入（`autoMemory` + `<mem_*>` 协议）——
不同的权威、不同的存储，**不是** canonical `memory_records` 召回。

★ 诚实边界：**不得**把上面任何一条说成"召回权威已全面服务端化"。
本轮切的是**用户对话回合**；B/C 类路径如实登记在此。

---

## 12 · P21-R4-LIVE-3.4.1 · Exact Closure Frees

### 12.1 Authority scope（**不得**写成全局）
```
RECALL_SELECTION_AUTHORITY        = SERVER
RECALL_SELECTION_AUTHORITY_SCOPE  = DESKTOP_CONVERSATION_TURNS_ONLY
GLOBAL_RECALL_AUTHORITY           = NOT_CLAIMED
```
覆盖：单聊、群聊、以及审计表里归类为 **A** 的 conversation-turn 入口。
**不覆盖**：B 类非对话路径（日志留言 / 标注 / 信件 / one-line / role↔role DM /
transport retry / 工具续轮 / 诊断 peek / 主动日记 / exposure sink）与
C 类 Auto Memory（另一套权威、另一个存储）。逐条表见 §10.10。

### 12.2 Exposure 指标命名（消除二义）
旧写法 `HOME_NODE_EXPOSURE_WRITES = 1` 与"2 条 memory ⇒ 2"并存属于二义表达。冻结为：
```
HOME_NODE_EXPOSURE_OPERATIONS_PER_TURN = 1                    （每回合**一次** exposure 生命周期操作）
HOME_NODE_EXPOSED_MEMORY_COUNT         = selectedIds.length   （该次操作覆盖的记忆条数）
BROWSER_EXPOSURE_OPERATIONS_PER_TURN   = 0                    （浏览器零写）
```
即：**操作数恒为 1，条数随选择变化**。实测：真实浏览器回合选 2 条 ⇒
`OPERATIONS_PER_TURN = 1`、`EXPOSED_MEMORY_COUNT = 2`。

### 12.3 Request identity（复用既有事实源）
```
DESKTOP_RECALL_REQUEST_ID_SOURCE = EXISTING_TURN_ID   （_turn.turnId ← turnIdFor(userMsg.id)）
NEW_PERMANENT_ID_REQUIRED        = NO
同 logical transport retry       ⇒ 同 turnId（同一逻辑回合，不产生第二次 effect）
新 user turn                     ⇒ 新 turnId
```

### 12.4 Group identity（seam → wire 已实测）
`isGroup` 确实离开浏览器并到达服务端契约（客户端白名单已补；该缺口由真实浏览器
验证抓到）。两角色交错**不得共享** selected memories / session exposure /
activation / turn identity（`GROUP_ISOLATION = CLEAN`，含阳性对照）。

### 12.5 最决定性 authority 证据
```
DESKTOP_RECALL_AUTHORITY_NEGATIVE_CONTROL = SERVER_WINS
```
浏览器选择器被替换为返回 `[m_fake]` 的实现，被调用 **0 次**；最终 prompt **只含**
服务端选中项；decoy 在任何 prompt 中都不出现。

### 12.6 Stale mirror
canonical 与 mirror 冲突时：**selection = canonical**、**prompt context = canonical**；
浏览器**不得** substitute / reselect / 补位。

### 12.7 First-token 成本（诊断）
loopback recall 进入 first-token 关键路径：实测 median **11.05 ms** / p95 **16.3 ms**
（12 次采样，真实浏览器）。**不是零开销**；不设硬阈值。

---

## 11 · 本阶段**未**做（cutover 之外）

* Interpretation production gate **未开**（`R4C_PRODUCTION_EXECUTION = DISABLED`）；
* **未**把 server recall 接到 Interpretation（只保证结构上未来可直接消费）；
* 浏览器召回引擎**未退役**（`PRESENT_FOR_ROLLBACK_AND_DIAGNOSTICS`，memory.js 未改）；
* `IDS_ONLY_SELECTION_HEADER_POLICY = UNRESOLVED`（continue debt）；
* glossary 生产来源仍 **dormant**（两侧都没有 provider，未为此新造 catalog authority）；
* Expectation / R4-F **未开始**（`R4_F_LIVE_MEDIATOR_REQUIREMENT = L3_AND_L5` 未变）。
