# P28-1 · Agent Runtime Boundary Freeze
> **这是 IB 关于"什么是 Agent Runtime"的规范架构决定。**
阶段性质：**ARCHITECTURE DECISION CLOSURE / BOUNDARY FREEZE / NO PRODUCTION IMPLEMENTATION /
NO NEW RUNTIME / NO CONVERGENCE / NO EVENT BUS / NO SCHEMA CHANGE / NO COMMIT**。
上游证据：P28-0（PASS WITH NOTES）· P27-CLOSURE（PASS WITH NOTES / LOGICALLY FROZEN）·
P26-CLOSURE（PASS WITH NOTES / LOGICALLY FROZEN）· P25 / P24 / P23（FROZEN）。
---
## 1 State
**P28-1 State: PASS** —— **P28 RUNTIME BOUNDARY FROZEN**。
本阶段**零 production 变更**：只新增本文档 + `tests/test_p28_1_runtime_boundary_freeze.js`
（F1–F15 语义守卫）+ `tests/test-all.js` 注册。
---
## 2 Frozen Agent Runtime Definition
**IB 语境下的 Agent Runtime（冻结）**：
> **Agent Runtime 不是（也不必是）一个全局模块。**
> 一个 **域运行时（Domain Runtime）** 是一个**生产闭环**，把**域自己拥有**的触发推进到
> **canonical effect**：
> ```
> trigger → context → (optional model execution) → domain decision / planning
>   → permission / authority → execution → canonical writer → verification
> ```
> **共享的模型执行**一律委派给 `IB.runtime`（唯一共享执行缝）。
此定义**保留域所有权**：闭环内的每一段都归**该域**，不归任何"统一运行时"。
---
## 3 Existing Runtime Topology
```
                    [ 域触发：tick / 计划 / 用户回合 / 角色行为 ]
                                     │
          ┌──────────────┬───────────┼────────────┬──────────────┐
          ▼              ▼           ▼            ▼              ▼
       Moments        Diary    Active Message  Role Letter     Group
     (候选/语义/裁决) (生成/重复) (计划/发送/ACK) (选人/冷却)  (participation)
          │              │           │            │              │
          └──────────────┴─────┬─────┴────────────┘              │
                               ▼                                 │
                    IB.runtime（共享模型执行缝）                  │
                     resolveModel → execute → observe            │
                               │                                 │
                               ▼                                 ▼
                    Model Provider / Adapter          P23 Delivery（群/单聊消息交付）
                               │                                 │
                               └──────────► 域 authority → 域 writer（唯一）◄──┘
```
**方向是** `Domain Runtime → IB.runtime → Model Provider`；
**不是** `Global Agent Runtime → all domains`。
---
## 4 Shared Model Runtime Boundary（`IB.runtime`）
**它拥有（冻结）**：resolve model/provider（`resolveModel`）· 共享消息组装（`composeMessages`，
适用时）· 执行模型请求（`execute`）· 观测执行结果（`observe`）。
**它明确不拥有（冻结）**：触发调度 · 域内 planning · capability selection · Domain Authority ·
canonical writes · delivery · group participation · 跨运行时队列 · 域重试策略。
**实证**：`agent-runtime.js` 源码内**没有** `dbPut/dbDelete/localStorage`、**没有** `setInterval/setTimeout`、
**没有** `Authority/decide(`、**没有** group 身份、**没有** `delivery/queue/typing`、**没有** `chatMessages`。
**不得扩张 `IB.runtime`**。
---
## 5 Domain Runtime Ownership Matrix（P28 运行时边界基线）
| 域 | 触发 owner | context owner | 模型路径 | 决策/计划 | authority | executor | canonical writer | verify | retry | cancel | delivery |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Moments** | Moments tick / 计划 | Moments | `IB.runtime` | Moments（+Autonomy Core 裁决） | Moments mutation authority | Moments | `_momentsWriteApprovedMoment` | Moments | Moments | Moments | — |
| **Diary** | `_diaryTick` | Diary | `IB.runtime` | Diary | Diary Authority | Diary | `_diaryWriteCanonical` | Diary | Diary | Diary | — |
| **Active Message** | Companion `schedulerTick` / 计划 | Active Message | `IB.runtime`（可回退 `callApiChat`） | 计划状态机 | **共享** Active Message Authority | `_sendRequest` → 事件 | 浏览器镜像写 `chatMessages` | 镜像 + ACK | `maxAttempts` | `cancelIfNewer*` / DND | —（消息落库由镜像） |
| **Role Letter** | `_roleLettersTick` | Role Letter | `IB.runtime` | Role Letter | Role Letter Authority | Role Letter | `_rlWriteCanonical` | Role Letter | Role Letter | — | — |
| **Group** | 用户消息（P24） | P24 + Chat 上下文 | Chat 执行器 | **P24 participation planner** | 域权威（群内动作）+ Autonomy 语义 | Chat 执行器 | `chatMessages`（Chat 域） | — | — | **P24 群回合取消** | **P23** |
| **Chat** | 用户命令 | Chat `composeMessages`/`loadContext` + Middle Brain | Chat 执行器（`callApiChat*`） | —（无显式计划） | — | Chat 执行器 | `chatMessages` | 交付自身 | 执行器 | 流中止 / delivery cancel | **P23** |
**结论**：每一列都有一个**具名域**所有者；**没有任何一列是"无主"的**。
---
## 6 Global Ownership Exclusions（未来统一运行时**不得**成为）
| 禁止形态 | 归属 |
| --- | --- |
| **Delivery Runtime v2** | P23（delivery/queue/typing/voice） |
| **Group Runtime v2** | P24（participation/speaker/`groupOrder`/`groupTurnId`） |
| **Autonomy Authority v2** | P25 Autonomy + 各域 Authority |
| **Canonical Writer v2** | 各域 writer |
| **Scheduler v2** | 既有域 scheduler / tick |
| **Middle Brain v2** | Middle Brain（上下文/人设/完整性职责已冻结） |
| **Model Provider Layer v2** | `IB.runtime`（已拥有执行缝） |
这些排除是**显式且可测**的（守卫 F11–F14）。
---
## 7 P25-3A Status
**冻结：P25-3A = AVAILABLE ORCHESTRATION CONTRACT（可用编排契约），不是生产 Agent Runtime。**
现状：未在生产加载；生产 `runAgentPlan` 调用者 = **0**。
**不得**为了"让它被使用"而加载它。
**采纳触发（adoption trigger）**：当真实场景需要 —— 跨 capability 规划 ·
多 capability 步骤 · 依赖排序 · 跨域共享编排 —— 时，才值得让 P25-3A 进入生产。
**单一域内的自主流程不构成充分理由。**
---
## 8 Capability Selection Status
**冻结：生产 capability discovery/selection = NONE，且这是 FUTURE CAPABILITY，不是 CURRENT DEFECT。**
依据：现有域运行时**已经知道**自己的域动作（Moments 发帖、Diary 写日记、Active 发消息、Letter 写信），
无需在多个 capability 之间选择。
**重估触发**：某个 model/agent 拿到一个**必须在多个 IB capability 之间选择**的目标。
---
## 9 P27 Consumer Freeze
| P27 输出 | 冻结状态 | 依据 |
| --- | --- | --- |
| `activity.created` | **NO_CURRENT_CONSUMER** | 无既有受益方（analytics/UI/agent/automation 皆无需要；记录本身可读） |
| `activity.state` | **USE_EXISTING_PATH** | `getActivityContext` 对当前 prompt 需求**更丰富**；用 Observation 替代会**削弱**语义 |
| Activity Session | **NO_CURRENT_CONSUMER** | 无人需要 session 身份（UI 用记录/指针更直接） |
**消费者为 0 是有效状态。** **不得**为了"证明集成"而制造消费者。
---
## 10 Feedback/Wake Freeze
**冻结：P26-5..10 保持未接线。**
现有触发是 **scheduled / character-triggered / human-turn-triggered**，**它们不是 Wake**。
Wake 只在以下情况变得相关：**一个新的运行时事实**使某个**原本休眠的 agent 变得值得激活**。
**禁止**把 scheduler tick 等同于 Agent Wake。
（`nudge` 仍是 Active Message 计划；Observation 不自动变成 Feedback；Session 不自动变成 Wake。）
---
## 11 P26-9 / P26-10 Settlement
**重新确认：`Activation Intent` / `Activation Runtime` = REDUNDANT_CANDIDATE**（本阶段**不删除**）。
**未来晋升规则（冻结）**：只有当**真实生产边界**要求下列之一时，才可考虑让它们进入生产 ——
**不同的 owner** / **不同的信任边界** / **不同的进程或运行时边界** / **不同的失败语义**。
**四者若无其一 ⇒ 不接线。**
---
## 12 active_agent_runtime Meaning（防漂移条款）
`active_agent_runtime` 是 **Economy consumer identity**，其**运行时锚点**是
`runtime/component-registry.js#active`（**既有 Active 组件**）。
**它不得被当作"统一 Agent Runtime 存在"的证据。**
本阶段**不重命名**任何 Economy 标识符。
---
## 13 No-op Ownership
**冻结："什么都不做"今天仍由域拥有**：Moments（没有值得发布的内容）·
Active Message（没有值得发送的主动消息）· Diary（不需要写）· Role Letter（不需要写）。
**不得**引入全局 no-op planner；**capability 级的全局 no-op 判定**要等到
**跨 capability 规划存在之后**才相关。
---
## 14 Scheduling Ownership
**冻结：调度仍属域**（Active Message scheduler · Diary tick · Moments tick · Role Letter tick）。
未来运行时**不得吸收** scheduler 语义：运行时可以**接收**一个"已到期的触发"，
但**不必拥有**产生该触发的 scheduler。
---
## 15 Retry / Dedup / Cancellation Ownership
**冻结：这些语义按域分布。禁止**创建全局 `RetryManager` / `DedupManager` / `CancellationManager`
—— 现有语义在各域**实质不同**：
Active Message（`maxAttempts` / newer-plan 取消 / user-reply 取消）·
Diary（候选幂等 / 重复检查）· Moments（相似度）· Role Letter（每日 + 对偶冷却）·
Group（回合取消）· Chat（流中止 / 工具队列消费）。
---
## 16 Model Invocation Rule
**冻结：未来的域运行时与未来的编排都应复用 `IB.runtime`。**
若共享执行缝能表达该请求，就**不应**直接调用 provider。
例外必须给出"`IB.runtime` 无法表达所需模型执行语义"的证据。**现在不扩张 `IB.runtime`。**
---
## 17 Context Ownership
**冻结既有上下文所有者**：Chat `composeMessages`/`loadContext` · Middle Brain ·
Activity `getActivityContext` · Memory 域 · 关系/理解域 · Group context。**禁止 ContextManager。**
未来运行时应**组合**既有上下文缝，而不是集中所有权。
---
## 18 Cross-runtime Rule
**冻结：Agent Runtime 默认不是跨运行时的。** 今天**唯一**真实的跨运行时域是 **Active Message**
（Node 产生事件/输出 → 浏览器 canonicalize 进 `chatMessages`）。
未来跨运行时架构需要**具体的域需求**；**不得**把 Active Message 的传输泛化成全局运行时总线。
---
## 19 Unified Runtime Adoption Criteria
| 触发条件 | 分类 |
| --- | --- |
| A. 一个目标必须在多个**域 capability** 之间选择 | **STRONG ADOPTION SIGNAL** |
| B. 一个计划必须**跨多个域**执行 capability | **STRONG ADOPTION SIGNAL** |
| C. 需要**跨 capability 的依赖排序** | **STRONG ADOPTION SIGNAL** |
| D. 共享编排状态必须**跨域步骤存活** | **STRONG ADOPTION SIGNAL** |
| E. 多个域需要**同一套** trigger→plan 协调语义 | SUPPORTING SIGNAL |
| F. 一个真实的 P26 Event/Feedback 消费者必须激活**通用 planner** | SUPPORTING SIGNAL |
| G. 一个通用 planner 必须把 action 交给 **P25 编排** | SUPPORTING SIGNAL（通常与 A–D 同时出现） |
| H. 单一 cancellation/causation 链必须**跨多个域** | SUPPORTING SIGNAL |
**不要求全部满足**；A–D 任一 + 真实调用者，即足以启动设计。
---
## 20 Non-adoption Criteria（**不足以**支持统一运行时）
仅共享模型调用 · 仅共享上下文 helper · 只是名字里都有 "agent" · 同一个 source 枚举 ·
某一个域的 scheduler · 某一个 Domain Event · 某一个 Observation · 某一个 Session 投影 ·
某一个自主功能 · Economy consumer 名字 · **为了架构对称的愿望**。
---
## 21 Future Decision Gate
**在创建统一 Agent Runtime 之前，提案必须证明"至少一条真实的跨域执行流，无法被既有域运行时干净地拥有"。**
提案必须给出：真实调用者 · 真实目标 ·（若跨域）**至少两个** capability/域 ·
当前重复的逻辑 · 必需的共享状态 · 失败语义 · authority 边界 · canonical writer ·
以及**为什么需要 P25-3A**。
**缺少这些证据 ⇒ REJECT / DEFER 统一运行时工作。**（本门禁**不**以运行时代码形式实现。）
---
## 22 Architecture Shape Freeze
**Shape D**：**没有统一 Agent Runtime**；保留 5 个域特有运行时；
并保留 Shape A 的**一个已存在维度** —— `IB.runtime` = **规范的共享模型执行缝**。
两者不矛盾：`Domain Runtime → IB.runtime → Model Provider`，
而**不是** `Global Agent Runtime → all domains`。
---
## 23 Event Bus Decision
**冻结：EVENT BUS NOT REQUIRED。** 重估条件：出现**多个独立消费者** / **fanout** /
**跨运行时路由** / **投递保证** / **回放** / **排序要求** 的证据。**不得创建 Event Bus。**
---
## 24 Persistence / Schema
未新增任何运行时持久化。**冻结 `DB_VER = 24`**；**不得**新增 Agent Runtime store /
Agent Session store / Agent Plan store / Wake queue / Consumer queue。
未来持久化必须有**真实的耐久事实所有者**。
---
## 25 Guard
`tests/test_p28_1_runtime_boundary_freeze.js`（**F1–F15**，全部语义断言，**不用整文件哈希**）：
F1 `IB.runtime` 仍是生产加载的共享模型执行缝且被三日域消费 ·
F2 P25-3A 未被生产加载 · F3 无生产 `runAgentPlan` 调用者 ·
F4 `active_agent_runtime` 仍是 Economy consumer 身份（非模块/运行时入口） ·
F5 P27 输出消费者状态冻结（0 / 既有路径，且更丰富的 `getActivityContext` 仍在） ·
F6 P26-5..10 未接线 · F7 P26-9/10 非生产 · F8 无 Manager / Event Bus ·
F9 无 runtime/session/wake store · F10 `DB_VER = 24` ·
F11 P23 交付所有权完好 · F12 P24 群参与所有权完好 ·
F13 域权威/域 writer 仍属域（`IB.runtime` 零写库零裁决） ·
F14 `IB.runtime` 保持窄（无 timer / 无 chatMessages / 无 queue/typing / retry 留在执行器） ·
F15 不存在统一 runtime 生产入口。
---
## 26 Tests
本阶段 Level-2 聚焦：P28-1 冻结守卫 **15** · P28-0 runtime entry 守卫 **10** ·
P27 closure 守卫 **12** · P26 closure 守卫 **8** · P25-3A registry **13** ·
P25-3A orchestration **28** · Autonomy Core **41** —— 全部通过。**未跑 full quick**（无 schema/共享权威变更）。
---
## 27 Worktree
| 文件 | 类型 |
| --- | --- |
| `docs/P28-1-AGENT-RUNTIME-BOUNDARY-FREEZE.md` | 新增（本文件，规范决定） |
| `tests/test_p28_1_runtime_boundary_freeze.js` | 新增（F1–F15 语义守卫） |
| `tests/test-all.js` | 仅注册 |
**零 production 变更**：未改 `agent-runtime.js` / `communication.js` / Middle Brain / P23 / P24 /
P25 core / P26 core / Activity / Economy / scheduler / 域权威。
---
## 28 Commit Readiness
**COMMIT DEFERRED BY OWNERSHIP.** 混合所有权工作树；未 stage、未 commit。
---
## 29 Known Limitations
- 冻结的是**当前证据下的边界**；若出现 §19 A–D 级别的真实跨域需求，本文件必须**有意重开**（不是漂移）。
- P25-3A 的"可用编排契约"仍是**未被生产验证**的契约；本冻结不声明它正确，只声明它**今天不被需要**。
- P27 三项输出的零消费者是**有意**状态；其重估触发条件见 §9。
- 本阶段为**静态架构冻结**，未做动态运行验证。
---
## 30 Next Phase Recommendation
**下一步：真实需求驱动的生产消费/能力工作，而不是新运行时层。**
具体建议：优先做**既有域的功能演进**（Moments / Diary / Active Message / Role Letter / Group 的真实产品需求），
在这些需求中**自然出现**跨域目标时，才按 §21 的门禁启动"统一运行时"提案。
**明确不做**：实现统一 Agent Runtime · 生产加载 P25-3A · 接线 P26-5..10 ·
为 P27 造消费者 · 造 Event Bus · 改 schema。
---
## 附录 · Final Questions（Q1–Q30）
1. **IB 今天需要统一 Agent Runtime 吗？** **不需要**。
2. **IB 里 Agent Runtime 是什么？** 把**域自己拥有**的触发推进到 canonical effect 的**域运行时闭环**（§2）。
3. **`IB.runtime` 拥有什么？** 共享**模型执行缝**：resolveModel / composeMessages / execute / observe。
4. **它绝不能悄悄吞并什么？** 调度 / 域计划 / capability 选择 / Authority / canonical writes / delivery / group participation / 跨运行时队列 / 域重试策略。
5. **今天有多少个域特有运行时？** **5 个**（Moments / Diary / Active Message / Role Letter / Group）+ Chat 执行器。
6. **P25-3A 是生产运行时吗？** **不是**（可用编排契约）。
7. **P25-3A 何时应被生产消费？** 出现跨 capability 规划 / 多 capability 步骤 / 依赖排序 / 跨域共享编排时。
8. **生产缺失 capability selection 是缺陷吗？** **不是**，是**未来能力**（域运行时已知自己的动作）。
9. **P27 输出现在需要消费者吗？** **不需要**（`activity.state` 走既有更丰富路径）。
10. **P26-5..10 现在需要生产接线吗？** **不需要**（现有触发是 scheduled/character/human，不是 Wake）。
11. **P26-9/10 仍是 REDUNDANT_CANDIDATE 吗？** **是**。
12. **`active_agent_runtime` 到底是什么？** Economy **consumer 身份**，锚定既有 Active 组件。
13. **谁拥有 no-op 决策？** **各域**。
14. **谁拥有调度？** **各域 scheduler / tick**。
15. **谁拥有 retry/dedup/cancellation？** **各域（+ scheduler / delivery runtime）**，按域分布。
16. **谁拥有模型执行？** **`IB.runtime`**（自主域）+ Chat 执行器（chat）。
17. **谁拥有上下文？** Chat `composeMessages`/`loadContext` · Middle Brain · Activity `getActivityContext` · Memory 域 · 关系/理解域 · Group context。
18. **未来 Agent Runtime 应直接调 provider 吗？** **不应**——复用 `IB.runtime`。
19. **应拥有 Domain Authority 吗？** **不应**。
20. **应拥有 canonical writer 吗？** **不应**。
21. **应拥有 P23 delivery 吗？** **不应**。
22. **应拥有 P24 group participation 吗？** **不应**。
23. **什么证据能支持统一运行时？** §19 的 A–D（跨域 capability 选择 / 跨域执行 / 依赖排序 / 跨域共享状态）+ 真实调用者。
24. **什么证据不充分？** §20 全部（共享模型调用、共享 helper、同名、单一 event/observation/session、Economy 名字、对称性愿望…）。
25. **未来的决策门禁是什么？** §21：必须先证明"至少一条无法被既有域运行时干净拥有的跨域执行流"，并给出调用者/目标/跨域 capability/重复逻辑/共享状态/失败语义/authority/writer/P25-3A 必要性。
26. **冻结的是哪个架构形状？** **Shape D**（+ 已存在的共享模型执行维度）。
27. **需要 Event Bus 吗？** **不需要**。
28. **需要新持久化吗？** **不需要**（`DB_VER = 24`）。
29. **本阶段改动生产了吗？** **没有**（零 production 变更）。
30. **接下来应该做什么？** 既有域的**真实产品需求**驱动；跨域需求出现时再按 §21 门禁启动提案。
