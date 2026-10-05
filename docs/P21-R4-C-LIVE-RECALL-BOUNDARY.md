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
  `selectedMemoryIds` `credentialRef` `provider` `model` `endpoint`
  `systemPrompt` `messages`
  （末行 7 个是 P21-R4-LIVE-4.1B §5 的标签修正：`selectedMemoryIds` 是
  `selectedIds` 的解释边界别名，其余 6 个是执行权威字段 —— 两类都是"调用方
  试图提供权威"，与无害未知键（写错键名）不是同一件事，因此不再混进
  `request-field-forbidden`。同一个 400、同样带 `field`、零次 retrieve。）
* `request-field-forbidden`（400）：其余未知键（闭集）。
  ★ 例外（既有语义，P21-R4-LIVE-4.1B 未改）：`ownerId` 等"跨角色 payload"
    字段仍走这个码 —— LIVE-3.3 的 request-authority 套件 §25.3 就是这样钉的。
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

---

## 12 · P21-R4-LIVE-4.3 · Auto Interpretation 的**生产成本权威**（文件策略）

自动解释的成本开关终于有了一个**服务端自有**的权威。它不是 env、不是浏览器设置、
不是 Middle Brain 旗标、不是 Economy 余额、不是 `character_runtime_specs`，
也**不是**新的 schema：权威是这台节点自己的一个 JSON 文件。

```
文件      <dataDir>/runtime-policy.json
形状      { "version": 1,
            "default":   { "autoInterpretationEnabled": false },
            "characters": { "<characterId>": { "autoInterpretationEnabled": true|false } } }
写者      services/home-node/runtime-policy.js#set()  ← **唯一**写者，Node 侧
读着      runtime-interpretation.js#resolveCharacterAutoPolicy(characterId)
来源      describe().autoPolicy.authoritySource = 'FILE_POLICY'（生产）
          'TEST_INJECTION' 只在装配层显式注入测试缝（runtimeAutoInterpretationPolicy）时出现
```

* **为什么是文件**：LIVE-4.1/4.2 的结论是 `meta` 键或 `spec_json` 不需要 schema 变更，
  但**没有非浏览器写者** —— 阻塞点是 provenance，不是 schema。文件把 provenance 说清楚了：
  唯一写者是 Node 侧 `set()`，**没有 HTTP 路由、没有 window/IB 面、本阶段没有 Tauri 命令**。
* **FAIL-CLOSED（§15）**：文件缺失 · 读不动 · JSON 坏 · `version` 不对 ·
  `characters`/`default` 不是对象 · 值不是布尔 · 角色不在表里 ⇒ **OFF**。
  任何一条都不会把异常抛进召回路径；每个出口都是"一个布尔 + 一个原因"。读不动的**现存**
  文件绝不会被 `set()` 静默覆盖（`POLICY_FILE_UNUSABLE`）。
* **PER-CHARACTER（§4）**：`read(characterId)` 每次重新读文件，**没有跨角色缓存**，
  因此 A 的值不可能泄给 B（套件实测：A 开 ⇒ 恰好 1 次 provider 调用；B 关 ⇒ 0 次）。
* **默认全关（§7）**：fresh dataDir ⇒ 文件不存在 ⇒ 每个角色都 OFF
  （`AUTO_INTERPRETATION_ENABLED_CHARACTER_COUNT = 0`），不迁移、不推断任何 opt-in。
* **浏览器伪造无效（§6/§11）**：两条路由的请求体里 `enabled`/`autoInterpretationEnabled`
  都被闭集**逐名拒绝**，且策略文件在攻击前后**逐字节相同**（套件断言 hash 相等）。
* **外部路由**（`POST /internal/runtime/memory-interpretation`）**不受影响**：
  即使策略为 ON，它仍然是 503 `disabled`（两条 cost gate 是两个表达式）。
* 见 `tests/test_r4c_live_interpretation_policy.js`（39 断言）与
  `services/home-node/runtime-policy.js` 头部。

### 12.1 已登记的观察（boundary-verify task-38：**登记，不改行为**）

* **OBS-A · `set()` 的字段语义**：`set(characterId, enabled)` 写的是**整份文档**，
  它保留 `version` / `default` / `characters` 三个字段，**丢弃未知的顶层字段**。
  这是刻意的窄面：唯一写者只认自己那份形状，一个手工写进去的未知键不会借
  `set()` 获得"被官方保留"的地位。手工编辑该文件时请只用这三个字段。
* **OBS-B · `version` 必须是严格的数字 `1`**：字符串 `"1"` 不算（`=== SCHEMA_VERSION`）。
  这条以前是宽松的（`Number()` 归一化），于是一个**形状错误**的文件配上
  `default.autoInterpretationEnabled: true` 就能打开全局 default —— 与 fail-closed
  矩阵直接矛盾。已修，并在套件里钉了一条 `version:"1"` ⇒ OFF 的用例
  （reason `policy-version-unsupported`）。
* **OBS-D · 操作者路径**：生产侧唯一的写入口是
  `require('services/home-node/runtime-policy.js')` + `set()`；provenance 由两个服务的
  `describe()`（`runtimeInterpretation.describe().autoPolicy`、
  `runtimeRecall.describe().autoInterpretation`）如实自述。本阶段**不**新增 Tauri 命令、
  **不**新增路由。

---

## 13 · P21-R4-LIVE-4.4 · 冻结契约（exact closure）

以下是本阶段**冻结**的自述值。它们不是承诺，而是对**实测行为**的命名：
每一条都有对应的套件断言或机械证据（见 §12 与
`tests/test_r4c_live_interpretation_policy.js`）。

```
AUTO_INTERPRETATION_RUNTIME_READY                    = YES
INTERPRETATION_COST_AUTHORITY_READY                  = YES
INTERPRETATION_COST_AUTHORITY                        = SERVER_OWNED_FILE_POLICY
INTERPRETATION_COST_AUTHORITY_SCOPE                  = PER_CHARACTER_WITH_GLOBAL_DEFAULT
DEFAULT_AUTO_INTERPRETATION                          = OFF
PRODUCTION_ENABLE_PATH                               = OPERATOR_FILE_ONLY
CALLER_FACING_ENABLE_PATH                            = NONE
AUTO_INTERPRETATION_ENABLED_CHARACTER_COUNT          = 0
R4C_INTERPRETATION_LIVE                              = YES
R4C_INTERPRETATION_LIVE_SEMANTICS                    = PRODUCTION_INFRASTRUCTURE_LIVE_CAPABLE
R4C_AUTO_INVOCATION                                  = NOT_ENABLED_IN_PRODUCTION
EXTERNAL_INTERPRETATION_ROUTE_PRODUCTION_ENABLED     = NO
MAX_ADDITIONAL_MODEL_CALLS_PER_CHARACTER_TURN        = 1
POLICY_VERSION_MATCHING                              = STRICT
```

**这些值各自的意思（逐条，不含推论）**

* `AUTO_INTERPRETATION_RUNTIME_READY = YES` —— 自动解释的整条运行时链路存在且可端到端证明
  （召回 → 进程内绑定 → 非阻塞执行 → turn-local 私有结果），并且**默认关闭**。
* `INTERPRETATION_COST_AUTHORITY = SERVER_OWNED_FILE_POLICY` —— 成本权威是这台节点自有的
  `<dataDir>/runtime-policy.json`；唯一写者是 Node 侧 `runtime-policy.js#set()`。
* `PRODUCTION_ENABLE_PATH = OPERATOR_FILE_ONLY` / `CALLER_FACING_ENABLE_PATH = NONE` ——
  **启用权威只可能是操作者侧的**。请求体里的 `enabled` / `autoInterpretationEnabled`、
  环境变量、Middle Brain 旗标、凭据存在与否、Economy 余额**都不构成启用权威**：
  前两者在这条边界上根本没有读点，后三者与本策略无关（各自的拒绝理由见 §12）。
* `DEFAULT_AUTO_INTERPRETATION = OFF` 与 `AUTO_INTERPRETATION_ENABLED_CHARACTER_COUNT = 0` ——
  fresh dataDir ⇒ 文件不存在 ⇒ 每个角色都关；不迁移、不推断任何 opt-in。
  测试用的装配注入（`TEST_INJECTION`）**不计入**这个生产计数。
* `R4C_INTERPRETATION_LIVE = YES` + `R4C_INTERPRETATION_LIVE_SEMANTICS =
  PRODUCTION_INFRASTRUCTURE_LIVE_CAPABLE` —— "live" 的含义是**基础设施已具备生产能力**，
  而不是"生产里已经打开"：`R4C_AUTO_INVOCATION = NOT_ENABLED_IN_PRODUCTION`。
* `EXTERNAL_INTERPRETATION_ROUTE_PRODUCTION_ENABLED = NO` —— 外部路由
  （`POST /internal/runtime/memory-interpretation`）即使在本策略为 ON 时仍然 503 `disabled`：
  两条 cost gate 是两个不同的表达式。
* `MAX_ADDITIONAL_MODEL_CALLS_PER_CHARACTER_TURN = 1` —— 每逻辑回合最多一次自动解释，
  无重试；重放不产生第二次调用。
* `POLICY_VERSION_MATCHING = STRICT` —— `version` 必须**严格等于数字 `1`**；字符串 `"1"`
  不是合法形状（fail closed，reason `policy-version-unsupported`）。

**Fail-closed 面（缺失 / 坏形状 / 不可读 / 未知角色一律 OFF）**

策略文件**缺失** · **不可读** · **JSON 坏** · **不是对象** · **`version` 不支持（含 `"1"` 字符串）** ·
**`characters`/`default` 不是对象** · **值不是布尔** · **角色不在表里**（回全局 default，
而全局 default 默认 false）—— 上述每一种都返回 OFF，并带一个**具名 reason**，
绝不把异常抛进召回路径。一个**存在但坏掉**的文件不会被 `set()` 静默覆盖
（`POLICY_FILE_UNUSABLE`）。

---

## 14 · P21-R4-LIVE-5 · L5 期望（Expectation）冻结值

L5 期望**第一次**进入真实的服务端会话运行时。以下是冻结的自述值；每一条都有
对应的套件断言（`tests/test_r4d_live_expectation.js`，34 条）。

```
EXPECTATION_PROTOCOL_LAYER                     = FROZEN_UNCHANGED
EXPECTATION_REQUIRES_L3_INTERPRETATION         = NO
EXPECTATION_WITHOUT_INTERPRETATION             = CREATED_DEGRADED
LIVE5_SCHEDULING_REQUIRES_L3_SUCCESS           = YES
EXPECTATION_EXECUTION_KIND                     = MODEL
MAX_ADDITIONAL_EXPECTATION_MODEL_CALLS_PER_CHARACTER_TURN = 1
EXPECTATION_POLICY_AUTHORITY                   = SERVER_OWNED_FILE_POLICY
EXPECTATION_POLICY_FILE                        = runtime-policy.json#expectation
DEFAULT_AUTO_EXPECTATION                       = OFF
AUTO_EXPECTATION_ENABLED_CHARACTER_COUNT       = 0
NEW_EXPECTATION_MODEL_CALLS                    = 0
EXPECTATION_SCHEMA_CHANGE_REQUIRED             = NO
EXPECTATION_DURABLE_WRITES                     = 0
MAX_HELD_EXPECTATIONS                          = 64
TURN_EXPECTATION_TTL_MS                        = 600000
EXPECTATION_HOLDER_KEY                         = characterId+conversationId+turnId
PROMPT_MUTATION_FROM_EXPECTATION               = 0
BROWSER_VISIBLE_EXPECTATION_CONTENT            = NO
CROSS_RESTART_EXPECTATION_EXACTLY_ONCE         = NO
PREDICTION_ERROR_LIVE                          = NO
LIVE_CANONICAL_SOURCE_BINDING                  = NOT_IMPLEMENTED
BLOCKER                                        = LATER_OBSERVATION_AUTHORITY_NOT_CLOSED
```

**协议层与调度层是两条不同的声明。** 冻结的 R4-D 协议把解释标为 **OPTIONAL**
（`CONTRACT.md:1848`），并要求缺失时按 `interpretation-unavailable-degraded` **降级**
（`:1856-1857`）—— 因此 `EXPECTATION_REQUIRES_L3_INTERPRETATION = NO` /
`EXPECTATION_WITHOUT_INTERPRETATION = CREATED_DEGRADED` 是事实。本相位**没有**改动
该协议，也**没有**发明拒绝路径。同时，生产 seam 的**调度纪律**是另一回事：
只有一次**已验证的 L3 成功**之后才调度期望（`LIVE5_SCHEDULING_REQUIRES_L3_SUCCESS = YES`）。
两条声明分开报告，谁也不冒充谁。

**成本。** `EXPECTATION_EXECUTION_KIND = MODEL`：期望的**内容**由模型产生
（纯核心只做信封组装 / 严格校验 / 组装，没有规则生成器）。因此成本权威是
`runtime-policy.json` 的**期望段** —— 与解释段是**两个独立布尔**，由
`setExpectation()` / `set()` 各自写入，且两个写者都**往返保留**对方的段
（`set()` 过去会丢弃未知顶层键，那正是本段要修掉的陷阱）。
`Interpretation enabled ⇒ Expectation paid calls enabled` 因此**构造上不成立**。
期望段默认 OFF ⇒ `NEW_EXPECTATION_MODEL_CALLS = 0`；打开也只允许每角色回合
**至多 1 次**（`MAX_ATTEMPTS = 1`、`AUTO_RETRY = NONE`）。

**只产出，不消费。** `runtime-expectation.js` **不导出任何返回期望正文的入口**：
外部只能看到状态 / 计数 / 延迟 / 原因，因此"没有消费者"是**结构性**的而不是约定。
实测：期望正文不出现在任何 provider wire、召回响应、`/security` 或 `describe()` 里；
关系状态逐字节不变；零持久写。**PREDICTION ERROR 仍然 NOT live**：
later-observation authority 未闭合，本相位**不**强行结算。

---

## 15 · P21-R4-LIVE-5.1 · 精确闭合（冻结值）

L5 期望的**精确闭合**。以下每条都是实测值；括号里指出它由什么测量。

```
R4D_EXPECTATION_RUNTIME_READY          = YES
R4D_EXPECTATION_LIVE                   = YES
R4D_EXPECTATION_LIVE_SEMANTICS         = PRODUCTION_INFRASTRUCTURE_LIVE_CAPABLE
R4D_PROTOCOL_L3_INTERPRETATION         = OPTIONAL
R4D_DEGRADED_EXPECTATION_CREATION      = ALLOWED
LIVE5_SCHEDULING_REQUIRES_L3_SUCCESS   = YES
LIVE_EXPECTATION_WITHOUT_VALIDATED_L3  = NOT_SCHEDULED
EXPECTATION_EXECUTION_KIND              = MODEL
EXPECTATION_EXECUTION_KIND_SEMANTICS    = LLM_BACKED
EXPECTATION_COST_AUTHORITY             = SERVER_OWNED_FILE_POLICY
EXPECTATION_COST_AUTHORITY_SCOPE       = PER_CHARACTER_WITH_GLOBAL_DEFAULT
DEFAULT_AUTO_EXPECTATION               = OFF
AUTO_EXPECTATION_ENABLED_CHARACTER_COUNT = 0
EXPECTATION_INVOCATION_AUTHORITY       = HOME_NODE_VALIDATED_INTERPRETATION
EXPECTATION_INPUT_AUTHORITY            = SERVER_VALIDATED_L3_INTERPRETATION
EXPECTATION_INVOCATION_SEAM            = POST_INTERPRETATION_NONBLOCKING
MAX_HELD_EXPECTATIONS                  = 64
HOLDER_TTL_MS                          = 600000
HOLDER_SCOPE                           = character+conversation+turn
EXPECTATION_DURABLE_WRITES             = 0
CURRENT_TURN_PROMPT_MUTATION_FROM_EXPECTATION = 0
CROSS_RESTART_EXPECTATION_EXACTLY_ONCE = NO
PREDICTION_ERROR_LIVE                  = NO
BLOCKER                                = LATER_OBSERVATION_AUTHORITY_NOT_CLOSED
LIVE_CANONICAL_SOURCE_BINDING          = NOT_IMPLEMENTED
COUNTERFACTUAL_AUTO_CALLS              = 0
BEHAVIOR_EFFECT_CALLS                  = 0
R4F_AUTHORIZED                         = NO
```

### 15.1 协议层与调度层是**两条不同的**声明（不要合并）

| 层 | 值 | 含义 |
| --- | --- | --- |
| **协议层**（冻结的 R4-D 文本，本相位**一个字都没改**） | `R4D_PROTOCOL_L3_INTERPRETATION = OPTIONAL` · `R4D_DEGRADED_EXPECTATION_CREATION = ALLOWED` | 解释是**可选**的主观层；缺失时协议允许按 degraded 形态创建期望（`CONTRACT.md:1848` 与 `:1856-1857`） |
| **运行时调度层**（本相位的策略） | `LIVE5_SCHEDULING_REQUIRES_L3_SUCCESS = YES` · `LIVE_EXPECTATION_WITHOUT_VALIDATED_L3 = NOT_SCHEDULED` | 生产 seam **只在一次已验证的 L3 成功之后**才调度期望；所以活体路径上"有召回但没有可用解释"⇒ 自动创建数 = 0 |

**这两条必须分开报告。** 特别地：**不要**把调度纪律写成协议层常量 —— 任何声称
"期望在协议上**要求** L3 解释"的写法都会**篡改冻结协议**，正是审计
（对应 `.dsh-research/r4d-live5-audit.md` §5）抓到的那种混淆。
同理，§8 的"零创建"是**调度策略**的断言，**不是**"协议禁止降级创建"的断言：
协议允许降级创建，是我们的 seam 不去调度它。

### 15.2 执行种类的语义（消除 Predictive-Model 歧义）

`EXPECTATION_EXECUTION_KIND = MODEL` 指的是**语言模型**（LLM-backed 的模型调用），
**不是**统计学意义上的 "predictive model"：期望正文由模型生成，纯核心只做
信封组装 / 严格校验 / 组装（`expectation-shadow-core.js:219-286`）。
既有协议 enum 一个字未改；这里只是补一条**语义注解**。

### 15.3 成本权威

权威是这台节点自有的 `runtime-policy.json` 的**期望段**：
`readExpectation()` / `setExpectation()`，与解释段是**两个独立布尔**
（`autoInterpretationEnabled != autoExpectationEnabled`，没有任何隐式交叉启用）。
默认 OFF ⇒ `AUTO_EXPECTATION_ENABLED_CHARACTER_COUNT = 0` ⇒
`NEW_EXPECTATION_MODEL_CALLS = 0`。**浏览器请求体 / 环境变量 / Middle Brain 旗标 /
凭据存在与否 / Economy 余额都不是期望的启用权威** —— 前两者在本边界没有读点，
后三者与本策略无关。期望正文**永不**回到浏览器：`describe()` 只有状态 / 计数 /
延迟 / 原因。

---

## 16 · P21-R4-F · BehaviorEffect Server Runtime Closure（冻结值）

> **本条是 additive**：§15 的 `R4F_AUTHORIZED = NO` / `BEHAVIOR_EFFECT_CALLS = 0`
> 是 **LIVE-5.1 时点**的记录，逐字保留、不改写。§16 记录的是它之后发生的事：
> BehaviorEffect 的**服务端契约与运行时**落地了，但**活体仍未闭合** ——
> prompt placement 需要用户 own 的 `assets/js/communication.js`。

以下每条都是实测值（括号里指出它由什么测量）。

```
R4F_BEHAVIOR_EFFECT_RUNTIME_READY            = YES
R4F_BEHAVIOR_EFFECT_LIVE                     = NO
BLOCKER                                      = BROWSER_PROMPT_PLACEMENT_REQUIRES_USER_OWNED_FILE
BEHAVIOR_EFFECT_EXECUTION_KIND               = DETERMINISTIC_RULES
BEHAVIOR_EFFECT_INPUT_AUTHORITY              = VALIDATED_L3_AND_L5
R4_F_LIVE_MEDIATOR_REQUIREMENT               = L3_AND_L5
BEHAVIOR_EFFECT_APPLIES_TO                   = NEXT_ELIGIBLE_TURN
BEHAVIOR_EFFECT_CONSUMPTION                  = SINGLE_CONSUMPTION_NEXT_ELIGIBLE_TURN
SOURCE_TURN_RETROACTIVE_EFFECT               = NO
MAX_ADDITIONAL_BEHAVIOR_MODEL_CALLS_PER_CHARACTER_TURN = 0
MAX_COGNITIVE_EXTRA_MODEL_CALLS_PER_CHARACTER_TURN     = 2
BEHAVIOR_EFFECT_PROVIDER_CALLS               = 0
BEHAVIOR_EFFECT_CREDENTIAL_READS             = 0
BEHAVIOR_EFFECT_DURABLE_WRITES               = 0
MAX_HELD_BEHAVIOR_EFFECTS                    = 64
HOLDER_TTL_MS                                = 600000
HOLDER_SCOPE                                 = character+conversation+turn
replayBound                                  = EVICTION_BOUNDED_NO_LEDGER
CROSS_EVICTION_EXACTLY_ONCE                  = NO
RECALL_ENVELOPE_TOP_LEVEL_KEYS               = 17
BEHAVIOR_EFFECT_ENVELOPE_KEY                 = behaviorEffect
BEHAVIOR_EFFECT_ENVELOPE_VALUE               = CLOSED_EFFECT_OBJECT_OR_NULL
NO_SIGNAL_IS_FIRST_CLASS                     = YES
BROWSER_MAY_SUBMIT_BEHAVIOR_EFFECT           = NO
BROWSER_RECEIVES_BEHAVIOR_EFFECT             = YES_CLOSED_ENUMS_ONLY
PREDICTION_ERROR_LIVE                        = NO
PREDICTION_ERROR_CALLS                       = 0
COUNTERFACTUAL_AUTO_CALLS                    = 0
```

### 16.1 与 §15 的关系（相位切换，不是推翻）

| 项 | §15（LIVE-5.1 时点） | §16（R4-F 之后） |
| --- | --- | --- |
| `R4F_AUTHORIZED` | `NO` | 服务端**运行时**通道已存在且被实测；**活体仍 NO** |
| `BEHAVIOR_EFFECT_CALLS` | `0` | `0`（本层是确定性投影，没有模型调用可授权） |
| `HOLDER_SCOPE` | `character+conversation+turn`（期望） | `character+conversation+turn`（行为，**独立**持有者） |
| AUTHORITATIVE 信封 | 16 键 | **17 键**（第 17 键 `behaviorEffect`） |

**不要**把 §16 读成"R4-F 已 LIVE"。本轮范围明确是
**server contract / runtime only**：`R4F_BEHAVIOR_EFFECT_LIVE = NO`，
blocker 具名，且不得声称永久 exactly-once。

### 16.2 冻结的 v1 schema（闭集 7 键）

```
behaviorEffect = {
  stance, strategy, initiativeTendency, rationaleCode,
  sourceTurn, derivedFrom: 'L3_AND_L5', ttlTurns: 1
}
```

`validateEffect` 是**闭集键白名单**：白名单之外的键 ⇒ 不是效果。
`promptText` / `instruction` / `fragment` / `guidance` / `text` / `prompt`
逐名拒绝；`warmth` / `patience` / `openness` / `guardedness` / `protectiveness` /
`trust` / `familiarity` / `affinity` 逐名拒绝。**没有免费文本通道可以写** ——
不是"禁止写"，而是没有这个键。`derivedFrom` 的闭集**只有一个值**：
`L3_AND_L5`（`L3` / `L5` / `L3+L5` 一律 fail closed）。

### 16.3 中介（L3 **且** L5）与负例矩阵

派生输入不是两个布尔，而是**两个服务端结果对象**：
`interpretationResult` 必须是 `ok:true` + `status:'succeeded'` + `recordSource`
+ 结构合规的 shadow（每个 item 带非空 `memoryId` 且 `appraisal` 命中 R4-C 纯核心
的闭集）；`expectation` 必须是 `status:'created'`。实测负例：

| 输入 | 结果 |
| --- | --- |
| 只有 Recall | `l3-not-validated` ⇒ 无效果 |
| 只有 L3（期望 OFF） | 0 次派生 ⇒ 无效果 |
| 只有 L5 | `l3-not-validated` ⇒ 无效果 |
| 裸 L3 shadow 的 clone | `l3-not-a-server-result` ⇒ 无效果 |
| 结构伪造 L3（坏 appraisal） | `l3-shape-invalid` ⇒ 无效果 |
| 伪造 L5（`status != created`） | `expectation-malformed` ⇒ 无效果 |
| 浏览器提交 L3 / L5 / behaviorEffect | 请求闭集 ⇒ 400，零派生、零状态改变 |

★ 诚实边界：进程内**克隆一份完整的服务端结果对象**在结构上与原件不可区分
（`CLONE_OF_SERVER_RESULT_IN_PROCESS = NOT_DISTINGUISHABLE`）。真正的权威是
"**没有第二个调用方**"：本模块没有路由，RECALL 请求是闭集，唯一调用点是
`runtime-recall.js` 的期望 seam（`tests/helpers/runtime-seam-guard.js` 把它钉死）。

### 16.4 交付通道：第 17 键，与 `effects` 的边界

authoritative 信封从 16 键变为 **17 键**；第 17 键的值是**冻结对象本身**或 `null`
（没有 `status` 包装层 —— 包装层会变成第二个"效果长什么样"的权威）。
`effects` 仍然逐字是**召回生命周期**块（`turnBegun` / `activation` / `exposure` /
`turnEnded`），认知行为语义**不**混进去。

形状不随成功/失败分叉：知道 `mode` 的失败路径也回同一套 17 键（值为 `null`），
且**不消费**任何持有的效果；**校验期失败**（还没有可信的 `mode`）仍是冻结的
14 键基座失败信封，不含 `behaviorEffect` / `context` / `effects`。

### 16.5 持有者、消费语义与淘汰的诚实边界

* 持有者：**进程内**、非持久、64 条 / 600 000 ms、键
  `characterId+conversationId+turnId`；消费时只取**同角色 + 同会话**的
  最旧待取条目（§16 隔离：别的角色 / 别的会话在结构上取不到）。
* `SOURCE_TURN_RETROACTIVE_EFFECT = NO`：源回合**取不到自己**刚派生的效果
  （消费时按 `sourceTurn === 当前 turnId` 显式跳过）。
* 单次消费：取走即删除。重放**不消费**（重放的冻结语义是"不触碰任何状态"）。
* ★ `CROSS_EVICTION_EXACTLY_ONCE = NO`：被淘汰的旧回合可以再次产生效果。
  本相位**不加**任何持久账本，`replayBound = EVICTION_BOUNDED_NO_LEDGER`。
  把持有者去重描述成"永久 exactly-once"是**假话**。

### 16.6 NO_SIGNAL 是一等合法结果

中性 / 无信号（L3 的 `appraisal` 为 `neutral` / `unclear`，或没有可用条目）
⇒ **结构化中性效果**（`neutral|answer_directly|normal` + `rationaleCode:'no-signal'`），
**不是** `null` + fallback，也不是任意自然语言解释。固定渲染器对它给出
`NO_PLACEMENT`（一等结果，但**不**往 prompt 里塞一行）。
"每个 L3+L5 必然改变行为"是**假**命题。

### 16.7 固定渲染器契约（下一相消费，本轮不接）

* renderer 的输入**只能是**闭合 `behaviorEffect` 对象（7 键）；
* 输出 = 固定模板 + enum 映射：`PLACEMENT | NO_PLACEMENT | REFUSED`，
  `REFUSED` 一律 fail closed（未知组合不放置）；
* 模板来自服务端自有表（3 行），**绝不**插入 `rationale` 自由文本 / L3 原文 /
  L5 原文；
* 指引文本内**明写**优先级：
  `SYSTEM_DEVELOPER_POLICY > EXPLICIT_USER_REQUEST > BOUNDED_BEHAVIOR_EFFECT_GUIDANCE`；
* 位置设计：`DEDICATED_SYSTEM_ROLE_MESSAGE`（独立 system 角色消息），
  而不是改 persona / `cfg.systemPrompt`。

### 16.8 守卫（seam 钉死 + 对抗样本）

`behaviorEffect` 只允许出现在 `runtime-recall.js` 的 **5 个具名位置**
（装配注入的 dep 行 · `behaviorEffectForEnvelope` · `failure` · `run` · `describe`），
且 `deriveAndHold` / `consumeForTurn` 各**恰好一次**、各只在自己的授权函数内；
选择阶段与 `scheduleAutoInterpretation` 体内**一个都不许有**。
`counterfactual` / `prediction-error` 仍然全面禁止（解释边界四域全禁，措辞未放宽）。
守自由 `tests/helpers/runtime-seam-guard.js` 承载（LIVE-5 两个套件 + R4-F 套件共用），
并由 5 个**对抗样本**（第二个 seam / 直接构造 / 错误函数读 holder /
selector 阶段派生 / 源回合直接消费）证明它真的抓得住伪造。

### 16.9 本轮实测抓到的两个缺陷（为什么这些形状是现在这样）

1. **`conversationId is not defined`**：候选的成功路径引用了 `run()` 里并不存在的
   局部绑定（校验器把身份放在 `shape` 里）。它让**每一次** authoritative 召回
   落进兜底 catch（`unexpected-boundary-error` ⇒ 503）—— "永不抛出"的契约把
   一个拼写错误放大成整条链路不可用。R4-F 套件的三步实测抓到并修掉了它。
2. **聚合 runner 的登记表空洞**：`tests/test-all.js` 里漏了一个逗号，
   `['a'] /* c */ ['b']` 被解析成成员访问 ⇒ 该槽位是 `undefined` ⇒ REGISTRY 构建
   **直接抛错**（HEAD 上即可复现）。"写了测试"与"每轮真的被跑"的缺口这次出现在
   聚合器自己身上；已修，且登记表空洞数实测为 0。

### 16.10 明确不做（本轮）

Browser prompt placement（需要用户 own 的 `assets/js/communication.js`）·
durable ledger · 第三个成本权威位（`autoBehaviorEffectEnabled` 这类"伪装成成本
权威的开关"）· 改写关系 / persona / speech style / tool policy / canonical memory /
Recall score / Expectation / Interpretation · Prediction Error 结算 ·
Counterfactual 自动调用。

---

## 17 · P21-R4-F.2 · Browser BehaviorEffect Placement（冻结值）

> **本条是 additive**：§16 记录的是"服务端就绪、活体未闭合"，
> 并冻结了 BLOCKER = `BROWSER_PROMPT_PLACEMENT_REQUIRES_USER_OWNED_FILE`。
> §17 记录 blocker 被**定向授权**解除之后的事实：第 17 键经浏览器固定 renderer
> 落成**一条独立 system 角色消息**。§16 的每一条 server 事实**一个字都没改**。

以下每条都是实测值（`tests/test_r4f_live_behavior_effect_browser.js`，真实 Chrome
+ 真实 Home Node + 真实 prompt assembly）。

```
R4F_BEHAVIOR_EFFECT_RUNTIME_READY       = YES
R4F_BEHAVIOR_EFFECT_LIVE                = YES
R4F_BEHAVIOR_EFFECT_LIVE_SEMANTICS      = PRODUCTION_INFRASTRUCTURE_LIVE_CAPABLE
BEHAVIOR_EFFECT_APPLICATION_TARGET      = NEXT_ELIGIBLE_CONVERSATION_TURN
BEHAVIOR_EFFECT_PROMPT_PLACEMENT        = DEDICATED_SYSTEM_ROLE_MESSAGE
BEHAVIOR_EFFECT_RENDERER                = FIXED_ENUM_TABLE_NO_SOURCE_TEXT_INTERPOLATION
BEHAVIOR_EFFECT_RENDERER_MODULE         = assets/js/behavior-effect-render.js
BEHAVIOR_EFFECT_RENDERER_LOAD_PATH      = DYNAMIC_SCRIPT_INSERT_VIA_COMMUNICATION_JS
INTERNALBEYOND_HTML_MODIFIED_BY_R4F2    = NO
SOURCE_TURN_RETROACTIVE_EFFECT          = NO
SOURCE_TURN_PROMPT_MUTATION_FROM_BEHAVIOR_EFFECT = 0
BEHAVIOR_EFFECT_DURABLE_WRITES          = 0
BEHAVIOR_EFFECT_BROWSER_DURABLE_WRITES  = 0
MAX_ADDITIONAL_BEHAVIOR_MODEL_CALLS_PER_CHARACTER_TURN = 0
MAX_COGNITIVE_EXTRA_MODEL_CALLS_PER_CHARACTER_TURN     = 2
PREDICTION_ERROR_LIVE                   = NO
COUNTERFACTUAL_AUTO_CALLS               = 0
AUTO_BEHAVIOR_EFFECT_ENABLED_CHARACTER_COUNT =
  NOT_APPLICABLE_NO_INDEPENDENT_ENABLE_BIT
```

### 17.1 §16 的 blocker 是如何被解除的（只读授权边界）

`assets/js/communication.js` 是**用户 own 的 dirty 文件**（相位前 113 个用户 hunk /
BOM=True / LF-only）。本相位拿到的是**窄授权**：保留第 17 键、调用固定 renderer、
放置 bounded guidance、replay/group/failure 的最小 wiring —— 仅此而已。

* **clean 候选先构造**：`CLEAN_HEAD` blob → 应用 8 个 hunk → `CLEAN_R4F2` blob
  → `R4F2_COMMUNICATION_PATCH_SHA256`；**不在 dirty 文件上试错开发**。
* 再把**同一份 hunk** 按锚点应用到 dirty 工作树（每个 `old` 在 clean 与 dirty
  里都**恰好出现一次**）。
* **机械证明**：把 8 个 hunk 反向替换回去，得到的字节与相位前的 dirty blob
  **逐字节相等** ⇒ `USER_HUNKS_BYTE_PRESERVED = YES`、
  `ILLEGAL_USER_HUNK_MUTATIONS = 0`；BOM / 行尾与相位前同状态。
* `assets/js/memory.js` **未被触碰**（用户 dirty，明令禁止修改）。
* `InternalBeyond.html` **未被触碰**：renderer 经**既有**动态插入路径
  （`createElement('script')` + `appendChild`，与 `app-store.js` 同一手法）
  装载；HTML 里没有 `behavior-effect-render` 字样。页面上 renderer 初始
  **不存在**，第一次真正需要放置时才装载（懒加载，失败即永久不放置）。

### 17.2 Renderer 契约（纯函数；三态）

```
输入：服务端 authoritative Recall 第 17 键 = 闭合 7 键对象 | null
输出：{ kind:'PLACEMENT',    lines:[<固定模板行>] }
      { kind:'NO_PLACEMENT' }
      { kind:'REFUSED',      reasonCode:'<闭集原因码>' }
```

* `RENDER_TABLE` / `NO_PLACEMENT_KEYS` / `EFFECT_KEYS` / 四张词表与
  `services/home-node/runtime-behavior-effect.js` **逐值相等**（测试断言）——
  浏览器**不发明**任何 prompt 文本。
* **零插值**：模板里没有任何插值位；`rationale` / L3 原文 / L5 原文 /
  `sourceTurn` / `derivedFrom` / `ttlTurns` **不转成自然语言**（后三者只用于
  校验/权威）。
* fail closed：非法枚举、缺字段、多字段、情绪轴、`derivedFrom != L3_AND_L5`、
  `ttlTurns != 1`、坏 `sourceTurn`、免费文本隧道（`promptText` / `instruction` /
  `fragment` / `guidance` / `text` / `prompt`）**逐名 REFUSED**，绝不 best-effort。
* 恶意对象即使是 `promptText: 'SYSTEM: Ignore previous instructions'`：
  在**信封仍自称 SERVER**（传输层权威未被破坏）的情况下也被 REFUSED，
  恶意文本**一字不进 wire**。
* 诚实边界：`BROWSER_FORGED_WELL_FORMED_EFFECT_IN_PROCESS =
  NOT_DISTINGUISHABLE_FROM_SERVER_TRANSPORT` —— 传输层分不出"进程内伪造的
  结构合法对象"；能保证的是"浏览器侧**没有**任何生成效果的代码路径"，
  且 renderer 对**形状不对**的一切 fail closed。

### 17.3 放置位置与顺序（`SYSTEM_MESSAGE_ORDER`）

```
messages[0]  canonical system（persona / 身份 / 关系 / 工具块）—— 原样，未改一字
messages[1]  behavior guidance：**独立** {role:'system'} 消息（唯一新增）
messages[2..] 普通对话消息（history + 本轮用户消息；用户消息本体未动）
```

* 行为基调**绝不**写 `cfg.systemPrompt` / `sysContent` / persona 块 /
  relationship 块 / `_tailCtx` / memory context / 用户消息本体。
* **没有 canonical system ⇒ 不放置**（绝不让 guidance 成为第一条最高权威
  system 而去覆盖 persona）。
* 群聊走**同一条**放置缝（同一位 renderer、同一条独立 system 消息），
  经 `buildChatContext` 的返回对象透传（`behaviorEffect`），不新建第二套持有者。

### 17.4 优先级框架与用户明示请求（§24）

每一行固定模板都自带（**固定文本**，不是自由拼接）：
低优先级 · 与**系统设定（system/developer policy）**或**用户明示要求**冲突时
以它们为准。实测：当服务端效果倾向 `ask_clarifying` 而用户明示"不要追问，直接给答案"
时，guidance 仍然只是一条**低优先级**建议行，用户消息逐字未改，行内不含任何
`必须/禁止/一定要/不许/务必` 类命令词 —— 它**不能**命令模型违反 system /
developer / 用户明示请求 / 工具安全。

机器可读声明：`PRIORITY = SYSTEM_DEVELOPER_POLICY > EXPLICIT_USER_REQUEST >
BOUNDED_BEHAVIOR_EFFECT_GUIDANCE`。

### 17.5 Prompt isolation matrix（实测）

| 输入 | 服务端第 17 键 | renderer | wire 上的 system 消息数 |
| --- | --- | --- | --- |
| A 无效果 | `null` | `NO_PLACEMENT` | 1（只有 canonical） |
| B NO_SIGNAL | 结构化中性对象 | `NO_PLACEMENT` | 1 |
| **C 合法非中性** | 闭合 7 键对象 | **`PLACEMENT`** | **2（canonical + guidance）** |
| D 非法（恶意隧道） | 被污染的对象 | `REFUSED` | 1 |

**只有 C 新增那一条消息**；Turn A（源回合）自身零 guidance；Turn C 在服务端回
`null` 时零陈旧 guidance（浏览器没有第二套 holder，也没有跨回合缓存）。
跨角色隔离：A 的效果不会进入 B 的回合（服务端已隔离，浏览器侧实测同样为 null）。

### 17.6 §34 为什么**没有**独立启用位

`AUTO_BEHAVIOR_EFFECT_ENABLED_CHARACTER_COUNT = NOT_APPLICABLE_NO_INDEPENDENT_ENABLE_BIT`。

BehaviorEffect 是**确定性投影**（0 次模型调用），因此**没有**第三个成本位：
不存在 `autoBehaviorEffectEnabled` 这样的开关（那会是"伪装成成本权威的启用开关"，
本相位刻意不加）。它的"活不活"完全由**上游两个既有布尔**自然约束：

```
Interpretation enabled  AND  Expectation enabled  ⇒ 该回合派生并交付行为基调
否则                                              ⇒ 第 17 键 = null ⇒ 零放置
```

shipped default 两个布尔都是 OFF ⇒ 新装节点上行为基调的放置次数 = 0，
**没有任何新增付费面**（整链最大额外模型调用仍是 1 + 1 + 0 = 2）。

### 17.7 本轮明确不做

Prediction Error 结算 · Counterfactual 自动调用 · 改写 relationship / persona /
speech_style / tool policy / canonical memory / Recall score / Expectation /
Interpretation · durable ledger · 第三个成本权威位 · 重构 bundling ·
更新 R2-A hash baseline（那属于用户/其它工作流的决定）。
