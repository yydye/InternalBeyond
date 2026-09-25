# P28-0 · Production Consumer & Agent Runtime Entry Audit
阶段性质：**READ-ONLY ARCHITECTURE AUDIT / EVIDENCE-FIRST / CONSUMPTION-LAYER DISCOVERY /
AGENT-RUNTIME ENTRY DISCOVERY / NO PRODUCTION MUTATION / NO NEW FOUNDATION / NO NEW MANAGER /
NO EVENT BUS / NO COMMIT**。
上游：P26 LOGICALLY FROZEN · P27 CLOSURE PASS WITH NOTES / LOGICALLY FROZEN。
---
## 1 State
**P28-0 State: PASS WITH NOTES**
- **主问题的答案：D 与 A 的组合** —— 仓库**已经存在**一个真实、被生产消费的执行运行时
  （`assets/js/agent-runtime.js` 的 ModelPort：`IB.runtime.instance.execute`），
  但**不存在**统一的 trigger→plan→authority→execute→verify Agent Runtime，而证据**不支持**
  现在造一个。
- 结论要点：现有域运行时**已足够**；最小缺失接缝 = **E（无必须新增的接缝）**；
  P27 三项输出消费者仍为 **0**；P26-5..10 无生产消费者；Event Bus **NOT REQUIRED**；
  **零 production 变更**。
## 2 Audit Scope
只读审计（静态检索 + 调用图 + 既有聚焦测试）；范围 = 全部生产 JS（assets / active / services / apps）
与 `InternalBeyond.html` 的加载面。禁止：新抽象、新 manager、改 P25/P26、改 schema、commit。
## 3 Existing Runtime Inventory
| 运行时 | 位置 | 触发 | 是否生产加载/消费 | 阶段 |
| --- | --- | --- | --- | --- |
| **ModelPort 运行时**（`IB.runtime`） | `assets/js/agent-runtime.js` | 被 3 个域**直接调用** | **加载 + 被消费** | resolveModel / composeMessages / execute / observe |
| Moments 自主运行时 | `moments.js` + `moments-autonomy.js` + `autonomy-core.js` | 30s tick / 计划 | 加载 + 生产 | candidate→semantic→finalize→autonomy→writer |
| Diary 自主运行时 | `active-diary/diary.js` + `diary-authority.js` | `_diaryTick` | 加载 + 生产 | 生成→模型→authority→writer |
| Active Message 运行时 | `active/scheduler.js` + `services/active-message-service.js` | 15s schedulerTick | 加载 + 生产（浏览器 + Node） | task/plan→authority→send→事件→镜像 |
| Role Letter 运行时 | `role-letters.js` + `role-letter-authority.js` | `_roleLettersTick` | 加载 + 生产 | 选人→生成→authority→writer |
| Group 运行时（P24） | `group-runtime-core.js` + `communication.js` 群分支 | 用户消息 | 加载 + 生产 | participation→member turn→delivery |
| Chat 执行器 | `communication.js` | 用户发送 | 加载 + 生产 | context→Middle Brain→model→tool rounds→P23 |
| **P25-3A 编排** | `agent-orchestration-core.js` / `agent-capability-registry.js` | — | **未加载、零调用** | **契约，不是运行时** |
## 4 P25 Orchestration Reality
- **是否生产加载？** **否**（`InternalBeyond.html` 无引用）。
- **谁调用？** 生产代码**零**调用 `runAgentPlan` / `validateAgentPlan` / `createCapabilityRegistry`
  （只有 4 个 adapter 与测试 `require` 它们）。
- **是否有真实 UI/runtime 调用？** **没有**。
- **是否 foundation-only？** **是**。
- **是否已代表部分 Agent Runtime？** 它代表**编排契约**（plan 校验 / 拓扑序 / adapter 路由），
  不代表**运行时入口**（无触发、无上下文、无模型、无 writer）。
- **它停在哪？** 停在"给一个**已存在**的 plan 做校验/执行"——即 **orchestration contract**，
  与 **runtime entry** 不是一回事。
## 5 Autonomy Core Consumers
`IBAutonomyCore.runAutonomyAction` 的**唯一生产调用者**是 `moments-autonomy.js`
（`moments.js` → adapter → `runMomentAutonomy` → `AUTONOMY.runAutonomyAction`）。
| 域 | 触发 | source | 模型 | 计划 | 直接执行 | 上下文 | 校验 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Moments | 30s tick / 计划 | `'schedule'`（candidate source ∈ schedule·character） | 有（生成候选/文案） | 有（候选裁决） | **不直接**执行（交 executor） | 有 | 有（`verify`/writer 后置） |
**Autonomy decision ≠ Agent Runtime**：它只回答"这个 action 是否允许"（ALLOW/DENY/DEFER），
无触发、无上下文、无模型、无 writer。
## 6 Moments Runtime
真实链：
```
30s tick / 计划 → 候选生成 → 语义推荐 → finalizeMomentCandidate → runMomentAutonomy
   → (Autonomy Core) → executor → _momentsWriteApprovedMoment → createMoment（唯一 writer）
修改面（点赞/评论/回复/删除）→ _momentsMutationAuthority → executor（独立于创建）
```
**是否已像"域特有 Agent Runtime"？** **是**（它是 IB 最完整的自主闭环之一）。
阶段齐备度：stimulus ✓ · context ✓ · decision ✓ · plan ✓（候选+拦截）· authority ✓ ·
execution ✓ · verification ✓。**缺失阶段：无**（域内闭环）。
## 7 Diary Runtime
```
_diaryTick（schedule/character 触发）→ 取素材 → 生成（经 IB.runtime 执行缝）→ 重复/幂等检查
   → diary-authority 裁决 → _diaryWriteCanonical（唯一 writer）→ Memory 侧写（委托）
```
**是否已是域特有自主运行时？** **是**。**是否需要全局 Agent Runtime 才能工作？** **不需要**
（模型执行已由 `IB.runtime` 提供；其余阶段域内自足）。**能否将来成为某个统一运行时的消费者？**
可以，但今天无证据要求。
## 8 Active Message Runtime
这是**最接近真实 Agent Runtime** 的既有路径（浏览器 + Node companion 两侧）：
```
schedulerTick(15s) → executeTask / executePlan → 生成（经 IB.runtime 执行缝）
  → _authorizeSend → 共享 Active Message Authority → _sendRequest
  → 事件队列（acknowledged:false）→ 浏览器消费者镜像落库 chatMessages
| 关注点 | 现状 |
| --- | --- |
| runtime ownership | Active Message 域（浏览器持有 canonical；companion 持事件队列） |
| scheduling | 15s tick + 计划状态机 + 宽限期 + 崩溃回收 |
| trigger | `schedule` / `ai_planned` / `due` / `ai_plan` |
| context | 域内组装（含 `validateProactiveReply` 重复探针） |
| model call | 经 `IB.runtime` 执行缝（可回滚到 `callApiChat`） |
| plan | 计划状态机（`scheduled`/`waiting_for_user`/… + `maxAttempts`) |
| authority | **共享 Active Message Authority**（浏览器与 Node 同一份模块） |
| execution | `_sendRequest` → 事件（**不**直接写 chatMessages） |
| verification | 浏览器镜像 + ACK（`acknowledged`） |
| retry | 计划 `maxAttempts` + `adaptiveSkipReason` |
| cancellation | `cancelIfNewerPlanExists` / `cancelIfUserReplies` / DND |
| cross-runtime | **HTTP 事件轮询 + ACK**（仓库唯一真实跨运行时域通道） |
**不要重命名它**（本阶段不改）。
## 9 Role Letter Runtime
```
_roleLettersTick（每角色 1 封/天 + 对偶 24~72h 冷却 + 模型门控）→ 候选收信人（关系驱动）
   → 生成（经 IB.runtime 执行缝）→ role-letter-authority → _rlWriteCanonical（唯一 writer）
   → 关系/私有记忆读写（角色各自 tick 生成）
```
**分类：domain-specific autonomous runtime**（有触发/上下文/模型/权威/writer），
但比 Active Message **简单一层**（无跨运行时、无 ACK、无队列）。
## 10 Group Runtime
```
用户消息 → canonical participants → 提及目标 → planParticipation()（P24-M3.2，唯一参与权威）
   → speaker selection（entry.order）→ MemberTurn（turnId/groupTurnId/speakerId/groupOrder）
   → Middle Brain / model（每成员一次）→ P23 delivery → canonical chatMessages
```
**问：Group Runtime 是否已是"对话回合的 Agent Runtime"？** **是，但仅限对话回合**：
它拥有 participation / speaker / groupOrder / 成员回合执行 / 取消。
**未来 Agent Runtime 不得重复**：`groupTurnId` · `speakerId` · `groupOrder` · participation planning ·
SILENT/DEFER/targeting。**INTERJECT 仍独立、未静默实现**。
## 11 Normal Chat Runtime
```
user send → 上下文装配（loadContext/composeMessages + Activity/Memory/关系注入）
   → Middle Brain（组织/压缩/收口）→ model/provider（callApiChat*）
   → 工具续轮（autoContinue + maxRounds）→ 响应落库 → P23 delivery → canonical chatMessages
```
**普通聊天有 observe/decide/plan/act/verify 吗？** **没有**：它只有
**context → model → response（+ tool rounds）**。没有显式 decide/plan/authority/verify 阶段
（"verify" 仅指生成后的 Middle Brain 收口与交付自身）。
## 12 Middle Brain Boundary
审计结论（today 所有权）：
| 能力 | 是否属 Middle Brain |
| --- | --- |
| context shaping（组织/压缩） | **是**（`middleBrainOrganizeContext` / `middleBrainContextPipeline`） |
| persona / Character Integrity Guard | **是**（`middleBrainFinalizeReply`） |
| OOC guard / 准入 | **是**（`middleBrainAdmissionGate`） |
| reasoning 配置 / Astra 判定 | **是**（`middleBrainAstraInvoke` / `middleBrainAstraJudge`） |
| **model invocation** | **否**（属 chat 执行器 / `IB.runtime`） |
| decision / tool selection / planning | **否** |
| memory / verification | **否**（Memory 属 Memory 域；verify 属各域） |
**不得**因为它在模型路径上就把它当 Agent Runtime。
## 13 Tool / Capability Execution
| 问题 | 事实 |
| --- | --- |
| 模型输出能否请求 capability？ | **能**（工具标记，如 `ws_read` / 生图 / 读图） |
| 谁解析？ | `communication.js` 的解析 + `_wsPending*` 队列 |
| 谁校验？ | 按工具（工作区/文件面各自校验） |
| 谁执行？ | `communication.js`（工具执行器） |
| 谁调用 Domain Authority？ | **不由工具调用**（域权威属于 domain runtimes：moments/diary/active/letter） |
| 谁把结果还给模型？ | `communication.js` 续轮注入 |
| 有 tool round loop 吗？ | **有**（`autoContinue` + 注入回注队列） |
| 最大轮数？ | **有**（`maxRounds = opts.maxContinues ?? _maxContinuesPref`，`round>=maxRounds` break） |
| cancellation？ | 有（turn/stream abort） |
| duplicate protection？ | 有（回注队列 + 消费即出队） |
| watchdog？ | 有（按域的重复相似度探针 / 超时） |
**现有 tool calling ≠ 未来统一 Agent Runtime**：它属于 **chat 执行器**，且与
capability registry（P25-3A，未接线）**不是同一条路径**。
## 14 active_agent_runtime Meaning
字面 + 语义审计结论：**F 组合，以 D 为主** ——
1. **不是**模块路径（`assets/js/active_agent_runtime.js` 不存在；HTML 无引用）；
2. **是 Economy consumer 身份**（`ECONOMY_CONSUMER.ACTIVE_AGENT_RUNTIME = 'active_agent_runtime'`）；
3. 它的**运行时锚点**是 `runtime/component-registry.js#active` —— 即**既有 Active 组件**，
   **不是**新的 agent runtime 模块；
4. 装配里**唯一的** `gate.bind(...)` 绑定的就是它（Chat/Group/Voice/Diary 等一律未绑）。
⇒ 它证明的是"Economy 需要一个**消费者身份**"，**不**证明统一 Agent Runtime 存在。
## 15 Economy Consumer Meaning
- Economy **确实**期待一个 runtime consumer：接口 = `gate.bind(consumerId)` → `createEconomyActionAdapter`。
- 该消费者能力表 = `[PROPOSE_PURCHASE, RESUME_APPROVED_PURCHASE]`（其中
  `RESUME_APPROVED_PURCHASE` 属"被决定方"的批准恢复路径）。
- **是否证明 Agent Runtime 存在？** **不**。它证明**存在一个被命名的消费者身份**，
  且该身份锚定在**既有 Active 组件**上。**不重设计 Economy。**
## 16 P27 Consumer Reality
复核（P27-C 结论）：`activity.created` / `activity.state` / `IB.activity.getSession` 的
**生产消费者 = 0**（对 12 个候选生产文件逐一检索 `getObservation|getSession|IBObservationCore|
IBSessionCore|activity.created` → 0 命中）。
## 17 Event Consumer Analysis
`activity.created`：谁真正受益于"知道它发生了"？
候选类别逐一验证：analytics/logging（**无既有消费者**）· UI 更新（**Activity 列表读 canonical 即可**）·
Agent context（**上下文走 canonical/context 路径，不需要事件**）· automation（**无既有自动化需要**）·
feedback（**P26-5..10 未接线且无消费者**）· cross-runtime transport（**Activity 纯浏览器**）。
⇒ **今天没有任何类别有证据支持**；消费者**保持 0 是允许的**。
## 18 Observation Consumer Analysis
对比：既有 `getActivityContext`（构造 prompt 文本，读 canonical `progress` 等）vs 新 `getObservation`
（引用式、只读、无正文）。
**既有 context builder 能不能自然地消费 Observation？** 它可以**读取**，但它的输出需要**内容**
（页文本/字幕切片），而 Observation 按契约**只带引用**。
⇒ 用 Observation 替代它会**削弱**语义（**P27-C 明令禁止**"为了宣称有消费者而用更贫弱的观察替换更丰富的读取"）。
**结论：`USE_EXISTING_PATH`**（观察保留为语义模型，等真正需要"状态位置引用"的消费者出现）。
## 19 Session Consumer Analysis
`getSession(activityId)` 的潜在需求面：Agent context（**今天无跨域 agent 需要 session 身份**）·
UI 状态（**App 直接用记录/指针，更直接**）· cross-device runtime（**不存在**）·
resource arbitration（**P27-5 DEFER**）。
⇒ **无当前受益消费者**；消费者**保持 0**，**不发明一个**。
## 20 Feedback/Wake Reality
检索 Event/Observation → Feedback → Consumption → Wake → Activation 的**真实等价行为**：
现有运行时**已经有显式调度/触发**（Active 15s + 计划、Diary tick、Moments 30s tick、Role Letter 每角色每日 + 对偶冷却、Group 用户回合）。
**这些运行时需要 P26 Wake 吗？** **不需要**：它们的"该不该动"由**域内计划/冷却/权威**回答，
不是由"新的运行时事实使休眠 agent 值得激活"。
## 21 Scheduled Trigger vs Wake（冻结）
- **Scheduled trigger** = "在/约时间 T 运行这个"。
- **Wake** = "一个新的运行时事实证明某个休眠 agent 值得被激活"。
**两者不自动等同**（本阶段冻结）。
现有触发分类：Active Message（**scheduled**）· Diary（**scheduled / character**）·
Moments（**scheduled / character**）· Role Letter（**scheduled**）· Group（**human turn**）·
Chat（**human command**）· 用户命令（**human**）。**零个是 Wake。**
## 22 Agent Runtime Responsibility Matrix
| 责任 | 当前所有者 |
| --- | --- |
| Trigger intake | **MULTIPLE**（各域自己的 tick / 用户命令 / 计划） |
| Context acquisition | **Chat**（loadContext/composeMessages）+ **Middle Brain**（组织/压缩）+ 域上下文（Activity/Memory/关系） |
| Observation acquisition | **Domain Runtime**（今日：直接读 canonical，不消费 `activity.state`） |
| Session lookup | **NONE**（`getSession` 无消费者；Activity 指针仅 UI 选择） |
| Intent formation | **Domain Runtime**（各域候选/计划） |
| Planning | **Domain Runtime**（+ Autonomy Core 裁决）；**P25-3A 编排未接线** |
| Capability discovery | **NONE 生产**（P25-3A registry 未加载；域内硬编码 capability） |
| Autonomy decision | **Autonomy Core**（唯一入口 `runAutonomyAction`，仅 Moments 消费） |
| Domain Authority | **各域权威**（moments mutation / diary / active-message / role-letter） |
| Execution | **各域 executor** |
| Verification | **各域 verify（+ companion ACK）** |
| Reflection | **NONE**（无通用反思层） |
| Model invocation | **`IB.runtime`（3 个自主域）+ Chat 执行器（chat）** |
| Tool loop | **Chat 执行器**（communication.js） |
| Cancellation | **MULTIPLE**（P24 群回合 / P23 delivery / 计划 cancelIf* / task abort） |
| Deduplication | **Domain Runtime**（重复探针 / candidateId / 相似度 / 对偶冷却） |
| Retry | **Domain Runtime / Scheduler**（计划 maxAttempts） |
| Scheduling | **Scheduler**（15s tick + 各域 tick） |
| Delivery | **P23** |
| Persistence | **各域 canonical writer** |
| Event consumption | **Companion → 浏览器镜像**（Active 单域） |
| Wake eligibility | **NONE**（P26-6/7/8 未接线，也无需求） |
## 23 Ownership Collision Audit
未来 Agent Runtime **不得**成为：
- **Delivery Runtime v2**（P23 拥有 delivery/queue/typing/voice）；
- **Group Runtime v2**（P24 拥有 participation/speaker/groupOrder/groupTurnId）；
- **Authority v2**（域权威拥有 permission）；
- **Writer v2**（域 writer 拥有 canonical mutation）；
- **Scheduler v2**（既有 tick/计划拥有调度）；
- **Middle Brain v2**（其 context/persona 职责已冻结）。
## 24 Model Invocation Ownership
| 路径 | 选 provider/model | 组装 messages | 调用 | reasoning | tool calls | retry |
| --- | --- | --- | --- | --- | --- | --- |
| 自主域（Moments/Diary/Active） | `IB.runtime.resolveModel(cfg)` | 域内 | `IB.runtime.instance.execute` | 域内/Provider adapter | 域内（禁用/白名单） | **域内**（runtime 不 retry） |
| Chat | chat 执行器 | 执行器 + Middle Brain | `callApiChat*` | 执行器 | 执行器（tool loop） | 执行器 |
⇒ 未来 Agent Runtime **应当复用**既有 model execution seam（`IB.runtime`），**不应**直接调用 provider。
## 25 Context Ownership
审计：`loadContext` / `composeMessages`（chat 执行器）· Middle Brain（组织/压缩/收口）·
Activity context（`getActivityContext`）· Memory（Memory 域）· 关系（关系/理解域）· Group context（P24 分支）。
**是否已有 canonical context assembly seam？** **有**：chat 执行器的 `composeMessages`
（`IB.runtime.composeMessages` 也复用同规模的历史尾部）。
⇒ **不创建 ContextManager**。
## 26 Cross-runtime Boundary
| 自主流 | 运行位置 |
| --- | --- |
| Active Message | **both**（Node 生成/入队 → 浏览器 canonicalize 落库） |
| Diary / Role Letter / Moments | **Browser only** |
| Group / Chat | **Browser only** |
⇒ 未来 Agent Runtime **初期应为 browser-only 或 runtime-neutral**，**不默认**跨运行时架构。
## 27 Cancellation / Duplicate / Retry Ownership
| 运行时 | 取消 | 幂等/去重 | 重试 |
| --- | --- | --- | --- |
| Active Message | `cancelIfNewerPlanExists` / `cancelIfUserReplies` / DND | 计划幂等 + `validateProactiveReply` 相似度 + 补偿跳过 | `maxAttempts` |
| Diary | turn/signal | 候选幂等键 + 重复检查 | 由域决定 |
| Moments | — | 相似度（0.82 / 评论相似度） | 域内 |
| Role Letter | — | 每角色每日 1 封 + 对偶 24~72h 冷却 | 域内 |
| Group | P24 群回合取消（保留已完成消息） | `groupOrder` 空洞保留 | — |
| Chat | 流式中止 / delivery cancel | 回注队列消费即出队 | 执行器 |
⇒ 这些**分属** domain runtime / scheduler / delivery runtime；
**不集中到**全局 runtime（无证据）。
## 28 No-op Semantics
| "什么也不做"的判定 | 当前所有者 |
| --- | --- |
| 没有值得发布的 Moments | Moments 域（候选/语义/裁决链） |
| 没有值得发送的 Active Message | Active Message（计划评估 + 权威 + 相似度探针） |
| 不需要写日记 | Diary 域（生成/重复检查） |
| 不需要 capability | **不存在该判定**（无 capability selection 生产路径） |
⇒ **模型不总是产生动作**这件事，今天**由各域自己回答**；这是成立的（无需全局层）。
## 29 Human vs Autonomous Boundary
| 类型 | 例子 | 语义 |
| --- | --- | --- |
| 显式用户命令 | 用户发消息 / 点按钮 | **human**（Chat 执行器） |
| 自主角色行为 | Moments 发布 / Diary / Role Letter | **character/schedule** |
| 计划行为 | Active Message | **schedule / ai_planned** |
| 群对话回合 | P24 group turn | **group_runtime** |
| 系统触发 | 回收/裁剪/宽限期 | **system** |
⇒ 未来运行时**不要求**把它们当成同一类；**不得抹掉域语义**。
## 30 Source Vocabulary
现状：`AUTONOMY_SOURCES = ['user','schedule','character','group_runtime','system']`（Autonomy Core）；
Moments 候选 `['schedule','character']`；scheduler 用 `'schedule'`；计划 `'ai_planned'`；
Diary/Letter 各自域内词表。
**是否需要统一 source 归一化？** —— **NOT REQUIRED**（P26-0 已定：域内版本化，禁止全局枚举）；
**USEFUL LATER**（若出现跨域消费者再议）。
## 31 Minimal Missing Seam
按 §25 的候选逐一核验：
| 候选 | 结论 |
| --- | --- |
| A. 把 trigger 转成 AgentPlan 的运行时入口 | **不需要**（各域已有自己的触发→计划；P25 编排未接线且无消费者） |
| B. 把 Observation/Session 喂给 planner 的 context adapter | **不需要**（上下文走既有 canonical/context 路径；用 Observation 会更贫弱） |
| C. Tool-round coordinator | **不需要**（tool loop 已在 chat 执行器，且有 maxRounds/回注队列） |
| D. 从真实事件到既有 planner 的 consumer adapter | **不需要**（无真实消费者） |
| **E. 无缺失接缝 —— 既有域运行时已足够** | **选中** |
## 32 Repository-specific Agent Runtime Definition
**IB 语境下的 Agent Runtime（提案，未冻结）**：
> 一个**将某个触发在某个域内推进为 canonical effect** 的闭环，包含
> trigger → context → (model) → decision/authority → execution → verify，
> 且**其 canonical write 只经该域唯一 writer**。
按此定义，IB **已有 5 个域特有 Agent Runtime**（Moments / Diary / Active Message / Role Letter / Group）
与 **1 个共享的 model execution seam**（`IB.runtime` ModelPort）。
**统一 Agent Runtime 不是必需**；它若要出现，必须证明"域特有闭环无法表达"的真实问题。
## 33 Runtime Input Requirements
若未来确有统一入口，**仅**记录被证据证明必要的字段（本阶段没有证据 ⇒ 不新增 envelope）：
候选 `trigger` / `actorId` / `source` / `domain` 已在各域现有输入中；`conversationId`/`activityId`/
`groupTurnId`/`causationId` 均已存在于**各自域**（P23/P24/P27-1），**不需要**再汇聚成全局信封。
## 34 Runtime Output Requirements
今天的完成语义由**各域**表达（计划状态机 / writer 结果 / ACK）。
**不重复** P25 状态词表，**不新增** status enum。若未来需要统一出口，应**引用**既有域结果，
而不是另立一套。
## 35 P27 Consumer Candidate Matrix
| P27 输出 | 现有可能消费者 | 真实需求 | 语义收益 | 既有等价路径 | 需要新运行时 | 建议 |
| --- | --- | --- | --- | --- | --- | --- |
| `activity.created` | 无（analytics/UI/agent/automation 均无既有需要） | NO | 低（信息可由 canonical 得到） | 有（记录本身） | NO | **NO_CURRENT_CONSUMER** |
| `activity.state` | `getActivityContext`（上下文装配） | NO | 低（会更贫弱） | **有且更丰富** | NO | **USE_EXISTING_PATH** |
| Activity Session | 无（UI 用记录/指针） | NO | 低（今天无人需要 session 身份） | 有（记录 + 指针） | NO | **NO_CURRENT_CONSUMER** |
## 36 P26-9 / P26-10 Recheck
带真实运行时证据复核：`Activation Intent` / `Activation Runtime` 仍为
**STILL_REDUNDANT_CANDIDATE** —— 没有任何生产消费者需要"激活意图/激活运行时"，
而 `READY` 之后的真实下一步是**域内执行**（已存在），不是又一次判定。
**修改它们**（本阶段不改）。
## 37 Event Bus Decision
本次审计**未**发现：多个独立消费者 · fanout · 跨运行时路由 · 投递保证 · 回放 · 全局序。
⇒ **EVENT BUS NOT REQUIRED**（唯一跨运行时通道仍是既有的 Active companion 事件，且它自带 ACK）。
## 38 Persistence / Schema Decision
**NO** new store · **NO** DB bump · **NO** runtime queue persistence · **NO** agent session persistence。
（DB_VER = 24；无 `agentRuntime`/`runtimeQueue`/`consumers` 等 store。）
## 39 Candidate Architecture Shapes
| Shape | 内容 | 与仓库事实的匹配 |
| --- | --- | --- |
| A. 采用既有运行时作为统一入口 | 以 `IB.runtime`（ModelPort）为标准入口 | **部分已发生**（3 个自主域已采用）；但它只覆盖 **model execution**，不覆盖触发/计划/权威 |
| B. 在 P25 编排上做薄 Agent Runtime 适配 | 薄层：trigger→plan→runAgentPlan | **无消费证据**（P25-3A 零调用、零消费者） |
| C. 把多个域运行时收敛到共享入口 | 统一 trigger/plan 面 | **证据不足**（各域闭环自足，语义差异大） |
| D. 暂无统一 Agent Runtime；逐个集成消费者 | 保持域运行时 + 按需接入消费者 | **与证据一致** |
## 40 Recommended Architecture Shape
**Shape D**（并在 model execution 维度上承认 **A 已发生**）：
- 保持 5 个域特有运行时与既有 model execution seam；
- **不**新增统一 Agent Runtime / Manager / Bus；
- 消费者**按真实需要**逐个接入（今天需要数 = 0）。
## 41 P28-1 Recommendation
**唯一推荐：`P28-1 · Agent Runtime Entry Decision Closure（Runtime Boundary Freeze）`**
（证据驱动命名）。
内容（**不含实现**）：把 §22 责任矩阵与 §23 碰撞清单**冻结**为 P28 的运行时边界定义；
正式记录"**不需要**统一 Agent Runtime"（Shape D + 已采用的 model seam）；
登记"未来何时才值得引入统一入口"的**采纳判据**；
并把 P27 三项输出的消费者保持 0 的状态与**重估触发条件**写入文档 + 守卫。
**不推荐**：`Agent Runtime Entry Integration`（会重复既有域运行时）、
`Existing Runtime Convergence`（无证据）、`Activity Context Consumer Integration`（会用更贫弱路径替换更丰富路径）。
## 42 Tests / Evidence
新增 `tests/test_p28_0_runtime_entry_guard.js`（**10 checks**，只读证据守卫）：
R1 `IB.runtime` ModelPort 真实存在且被 HTML 加载（§expose/instance/resolveModel/execute + retry 留在执行器）；
R2 被 Active Message / Diary / Moments 三个域**真实调用**（含回滚开关）；
R3 P25-3A 未加载且 `runAgentPlan` 零生产调用；
R4 `active_agent_runtime` = Economy consumer 身份（锚点 `runtime/component-registry.js#active`，
装配只绑它，且不是模块）；
R5 P27 三项输出消费者 = 0；
R6 Group Runtime 由 communication.js 生产调用；
R7 tool loop 归 chat 执行器（maxRounds/autoContinue）；
R8 Middle Brain 边界（生成后收口，不在 model seam 内）；
R9 DB_VER = 24、无 runtime 类 store；
R10 无新增 Bus/Manager。全部通过。
本阶段**未跑** full quick（§43 允许）；未跑浏览器 smoke（零生产变更）。
## 43 Worktree
| 文件 | 类型 |
| --- | --- |
| `docs/P28-0-PRODUCTION-CONSUMER-AGENT-RUNTIME-AUDIT.md` | 新增（本文件） |
| `tests/test_p28_0_runtime_entry_guard.js` | 新增（证据守卫） |
| `tests/test-all.js` | 注册守卫 |
**零 production 变更**：未改 `assets/js/**`、`active/**`、`services/**`、`InternalBeyond.html`、
P25/P26 core、DB schema。
## 44 Commit Readiness
**COMMIT DEFERRED BY OWNERSHIP.** 混合所有权工作树；未 stage、未 commit。
## 45 Known Limitations
- "Closest to a real Agent Runtime" 的判断基于**现有代码路径**；未来若出现新的跨域需求，结论可能改变。
- `getActivityContext` 与 `getObservation` 的对比是**语义**对比，不是性能/正确性缺陷。
- P27 三项输出的"零消费者"是**有意**状态，不是遗漏；重估触发条件见 §41。
- 本阶段未做动态运行验证（只读审计 + 静态证据守卫）。
---
## 附录 · Final Questions（Q1–Q33）
1. **真实 Agent Runtime 是否已存在？** **部分存在**：共享 **model execution runtime**（`IB.runtime`）真实存在且被 3 个域消费；**统一** Agent Runtime 不存在。
2. **若存在，在哪里？** `assets/js/agent-runtime.js`（`IB.runtime.instance.execute`）。
3. **若不存在，缺哪个确切责任？** 缺"**统一触发→计划入口**"——但**证据不支持**需要它（各域闭环自足）。
4. **是否有多个部分运行时？** **是**：Moments / Diary / Active Message / Role Letter / Group（5 个域特有）+ 1 个 model seam。
5. **哪个最接近 Agent Runtime？** **Active Message**（触发+计划+权威+执行+重试+取消+跨运行时+ACK）。
6. **P25-3A 今天是否被生产消费？** **否**（未加载、零调用）。
7. **谁把 trigger 变成 plan？** **各域自己**（Active 计划状态机 / Diary / Moments 候选 / Role Letter / P24）。
8. **谁调用模型？** 自主域经 **`IB.runtime`**；Chat 经 **chat 执行器**。
9. **谁拥有 capability selection？** **生产无**（P25-3A registry 未接线；域内硬编码）。
10. **谁拥有 permission？** **各域权威**（+ Autonomy Core 的 ALLOW/DENY/DEFER）。
11. **谁拥有 canonical writes？** **各域唯一 writer**。
12. **谁拥有 delivery？** **P23**。
13. **谁拥有 group participation？** **P24**。
14. **谁拥有 scheduling？** **既有 scheduler + 各域 tick**。
15. **谁拥有 verification？** **各域 verify（+ companion ACK）**。
16. **`active_agent_runtime` 在当前代码里到底是什么？** Economy **consumer 身份**，锚定既有 Active 组件（不是模块）。
17. **Economy 是否证明 Agent Runtime 存在？** **不**（只证明一个被命名的消费者身份）。
18. **`activity.created` 现在需要消费者吗？** **不需要**。
19. **`activity.state` 有天然既有消费者吗？** **有路径但不应替代**（`USE_EXISTING_PATH`）。
20. **Activity Session 有天然既有消费者吗？** **没有**。
21. **P26-5..10 今天有真实生产消费者吗？** **没有**。
22. **P26-9/10 是否仍是 REDUNDANT_CANDIDATE？** **是**（STILL_REDUNDANT_CANDIDATE）。
23. **需要 Event Bus 吗？** **不需要**。
24. **需要新持久化吗？** **不需要**。
25. **需要全局 source 词表吗？** **不需要**（域内版本化足够；未来或有用）。
26. **Agent Runtime 应直接调模型吗？** **不应**——复用既有 model execution seam。
27. **应拥有 delivery 吗？** **不**（P23）。
28. **应拥有 Domain Authority 吗？** **不**。
29. **应拥有 canonical writer 吗？** **不**（各域 writer）。
30. **应拥有 scheduler 语义吗？** **不**（既有 scheduler 保留）。
31. **最小缺失接缝是什么？** **E：没有必须新增的接缝**。
32. **哪个架构形状符合仓库现实？** **Shape D**（统一入口维度上 A 已发生）。
33. **P28-1 应具体做什么？** **Agent Runtime Entry Decision Closure（Runtime Boundary Freeze）**：冻结责任矩阵与"不需要统一 Agent Runtime"的结论 + 采纳判据 + 消费者重估条件（**不含实现**）。
