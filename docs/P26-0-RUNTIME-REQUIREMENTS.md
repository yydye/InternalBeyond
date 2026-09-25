# P26-0 · Runtime Architecture Requirements Closure

状态：**Requirements Baseline（需求基线）**，不是设计冻结、不是实现。
**Production code changed = 0。**

上游依据：`docs/P25-3E-ACTIVITY-BOUNDARY-AUDIT.md`、`docs/P25-3E-RUNTIME-GAPS.md`、
`docs/P26-0-ARCHITECTURE-MAP.md`（当前架构 + 缺口地图 + 边界矩阵 + 词汇矩阵）。

---

## 1. Gap #1 · Domain Event Mechanism

问题：**Domain Effect 发生以后，当前是否存在统一方式表达"发生了什么"？**

| domain | 今天有没有类似信号？ | 信号在哪里 | 谁消费 | 跨 runtime？ | 持久？ | 排序？ | ACK？ | replay？ | identity？ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| moment.created | 无域事件；只有 canonical 行 + 域内互动副作用 | `moments` store | UI（读取） | NO | 行持久，事件不持久 | 无 | 无 | N/A | moment id |
| diary.written | 无域事件；只有 canonical 行 | `diary_entries` | UI（读取） | NO | 行持久 | 无 | 无 | N/A | diary id |
| active_message.sent | **有**（本域自有事件队列：`status:'sent'` + ACK） | companion `events[]` + 浏览器 `_activePullCompanionEvents` | 浏览器消费者（镜像落库）、UI | **YES（HTTP 轮询）** | **YES** | 由轮询顺序（非全局序） | **YES** | 有限（未 ACK 保留） | `event.id` / `run_id` / `message_id` |
| role_letter.written | 无域事件；只有 canonical 行 + `toast` | `roleLetters` | UI（读取） | NO | 行持久 | 无 | 无 | N/A | letter id |
| activity.started / progressed / finished | **无**（`finished` 甚至没有写入者） | — | — | — | — | — | — | — | — |

**Event Mechanism ≠ Event Bus**（§10）：必须按性质区分，禁止"看到 emit/broadcast/events[] 就说已有 Event Bus"。

| 类别 | IB 中的实例 | 性质 |
| --- | --- | --- |
| LOCAL_CALLBACK | `IB.activity.on/off/_emit`；`IBApps` 的 `ctx.on` | 同进程同页面、无持久化、无 ACK、无 replay、`emit` 是 no-op |
| UI_EVENT | typing 指示器、小窗刷新、`online`/`visibilitychange` | 纯 UI 表现 |
| TRANSPORT_EVENT | `IBApps.broadcast`（宿主→当前 App）、Mobile Gateway 事件频道（不含正文） | 传输层"通知"，不承载域事实语义 |
| PERSISTED_DOMAIN_EVENT | Active Message 的事件队列（单域） | 有持久化 + ACK + 有限重放；语义是"发送结果交付" |
| DOMAIN_EVENT | **NOT PRESENT（通用意义）** | 无统一域事件；仅 Active Message 单域近似 |
| EVENT_BUS | **NOT PRESENT** | 没有跨域订阅/路由/投递语义；没有 bus |

**Event Requirement Test**：P26 是否需要**统一 Domain Event Mechanism**？**YES（HARD，最小集合）**。
需求（不定 API、不定 delivery guarantee）：

1. **domain-owned event identity**：事件必须有域内稳定身份（与 canonical 行 id 可关联，但不替代它）；
2. **producer semantics**：只有"effect 已经发生"的域可以发事件；事件**不得**成为第二个 writer；
3. **consumer semantics**：消费者按域订阅；不要求全局订阅面；
4. **ordering boundary**：顺序只需在 **per-domain / per-entity / per-session** 范围内可解释（§Event Ordering）；
5. **delivery guarantee**：**不预先**承诺 exactly/at-least/at-most-once —— 按域决定（今天唯一有 ACK 的域是 Active Message companion）；
6. **replay requirement**：仅在"canonical state 无法重建"的地方要求（今天：无新增证据 ⇒ 不强制）；
7. **ACK requirement**：仅在需要"消费确认才可丢弃"的域要求（今天：Active companion 事件）。

## 2. Gap #2 · Generic Observation Layer

今天真实的观察生产者与分类：

| 观察 | 分类 | 位置 | 是否落库 | 谁读 |
| --- | --- | --- | --- | --- |
| Cinema 留影帧 | **REQUEST_LOCAL_OBSERVATION** | `IB.activity.send(..., {visionReference})` → 本轮请求 → provider vision | **NO** | 本轮模型 |
| Cinema 播放进度 | **PERSISTED_OBSERVATION** | `activities.progress.sec/dur/upTo/pct` | YES（域字段） | `buildActivityContext` → 下一轮 prompt |
| Cinema 字幕切片 | **PERSISTED_OBSERVATION** | `activities.progress.subs`（最近 N 条） | YES | 同上 |
| Co-read 页/正文/梗概/书签 | **PERSISTED_OBSERVATION** | `activities.progress` / `bookmarks` | YES | 同上 |
| Activity context 文本 | **DERIVED_PROJECTION** | `buildActivityContext` / `getActivityContext` | NO | 聊天回合 prompt |
| 聊天上下文（历史/摘要/记忆） | **DERIVED_PROJECTION** | `communication.js` 的 context 构造 | NO | 本轮 prompt |
| 运行时状态投影（`resolveActivity` 结果） | **DERIVED_PROJECTION** | activity runtime | NO | 聊天回合 |
| 域状态读取（`getActivity` / `listActivities` / `_rlMemoriesFor` …） | **DOMAIN_STATE_READ** | 各域 | N/A | UI / 其它域 |
| UI 观察（进度条、typing、小窗） | **UI_OBSERVATION** | App 本地 | NO | 用户 |

**Observation ≠ Event**（§13 硬约束）：Observation 回答"现在是什么"，Event 回答"发生了什么"。
`current frame ≠ frame.changed`，`current progress ≠ progress.changed`。
本阶段检查的 pull/push 划分：

| 需求 | pull（read/projection）足够 | push（event）必须 |
| --- | --- | --- |
| 让下一轮 prompt 知道"读到哪"（进度/字幕/页） | **YES**（现有投影已足够） | NO |
| 让本轮模型看到一帧画面 | **YES**（request-local 参数） | NO |
| 让 UI 立刻反映"活动正在进行/已结束" | 部分（App 本地状态） | 未来（lifecycle 事件，见 Gap #1/#3） |
| 让其它 runtime 知道"某人刚写了信/发了动态" | NO | **未来条件性**（feedback policy） |

**Observation Authority Boundary**（§14）：只读观察**默认不进入 Domain Authority**
（没有"允许观察"的产品语义）；只有当**读取本身存在真实权限边界**时才需要授权
（今天真实存在的例子是 **Memory 可见性**（`isMemoryVisibleTo`）与 **Moments 可见性核**，
它们已经是既有的读取边界，不需要 P26 改造）。
⇒ **禁止**为了架构统一让 frame / progress / subtitle 经过 Authority。

**Observation Requirement Verdict**（§15）：**GENERIC_OBSERVATION_LAYER_REQUIRED**（最小需求）：

1. **producer registration**：允许域/运行时登记"只读生产者"（不含权限裁决）；
2. **read-only contract**：观察永远不产生 canonical effect、不需要 verifier；
3. **projection contract**：投影必须是确定性的、可重复读的（今天 `resolveActivity` 已是）；
4. **freshness metadata**：观察需能表达"多新"（今天靠 `lastActiveAt` / 每轮重算）；
5. **source identity**：观察需能指明"来自哪个实体/session"（今天靠 activityId / roleId）；
6. **runtime availability**：观察需能表达"当前不可用"（今天靠 `null` / 空串）。

## 3. Gap #3 · Session Runtime Contract

**session 是什么**（不预设 Activity = Session）：今天仓库里"跨多次动作存续"的对象只有：

- `activities` 记录（有 id / roleId / progress / status）—— **record**；
- `ib_activity_current_v1` —— **pointer**（可重建，自述不是 authority）；
- App 内 `_activity` / `_media adapter` / `subs` —— **view + runtime-only state**；
- 影片/书（`resourceId`）—— **resource**（外部对象，活动只是它的伴随会话）；
- Cinema/Co-read 的输入框与消息发送 —— **transport**（走聊天链路）。

**Session Ownership**（§17）：

| 归属项 | 今天的拥有者 | 说明 |
| --- | --- | --- |
| session identity | Activity 运行时（`act_*`） | 无跨域身份；只在 `activities` |
| session lifecycle | **NOT PRESENT** | 没有 start/finish/pause/resume；`status` 只有 `active`（`finished` 无写入者） |
| current selection | Activity 运行时（pointer） | 每角色一个指针 + 确定性回退 |
| participants | **NOT PRESENT** | 单角色 `roleId` |
| resource ownership | **NOT PRESENT** | `findActivity` 只做同资源复用 |
| start | Activity 运行时（`createActivity` + `setCurrent`） | 两个 home（store + 指针） |
| finish | **NOT PRESENT** | 最接近的是 `clearCurrent`（清指针）与 `deleteActivity`（删记录，无生产调用者） |

**Session State Boundary**（§18）：

| 类别 | 当前实例 | 是否 PRESENT |
| --- | --- | --- |
| CANONICAL DOMAIN STATE | `activities` 记录的字段 | PRESENT |
| RUNTIME STATE | App 内 `_activity/_aiId/subs/media adapter`；P23 交付队列 | PRESENT（分散） |
| POINTER | `ib_activity_current_v1` | PRESENT |
| DERIVED PROJECTION | `resolveActivity` / `getActivityContext` | PRESENT |
| RESOURCE LEASE | — | **NOT PRESENT（继续保持）** |
| PARTICIPANT STATE | — | **NOT PRESENT（继续保持）** |

## 4. Gap #4 · Resource Arbitration

真实冲突可能性分析（只按代码事实）：

| 组合 | 冲突？ | 依据 |
| --- | --- | --- |
| Cinema vs Cinema（同角色同资源） | **不冲突** | `findActivity` 复用同一条记录 |
| Cinema vs Cinema（同角色不同资源） | **并存**（今天允许） | smoke T6 同角色两条 active |
| Cinema vs Co-read | **并存**（不同 `type`/`resourceId`） | 无互斥检查 |
| multiple activities same role | **并存 + 指针择一** | `resolveActivity` 优先级 0–4 |
| Browser vs Node | **无资源交集** | companion 不拥有 Activity；它的 canonical 面是事件队列 |
| Group vs Activity | **无交集** | `group-runtime-core.js` 零 activity 引用 |
| Voice vs Activity | **无交集** | Voice 属 P23 交付域；语音呼入属 Active Message 的 `voice_call` 计划 |

是否存在：resource conflict **NO**；owner **NO**；lease **NO**；exclusive lock **NO**；
priority **NO**；preemption **NO**。

**Arbitration Requirement Verdict**（§20）：**RESOURCE_ARBITRATION_REQUIRED_FOR_FUTURE_SESSION_MODEL**。
理由（代码事实）：今天**没有任何真实冲突**（活动可并存、指针负责选择、跨域零交集），
因此"现在就要仲裁"不被证据支持；但一旦引入真正的 session 生命周期（Gap #3），
"独占 vs 并存"的判据必须有人拥有 —— 而它**既不是 authority（无状态裁决）也不是 scheduler（只管时间）**。

## 5. Conditional Gap · Participants / Feedback / Source Vocabulary

**Participants**（§21）：今天 Activity 是 1:1 `roleId`；P24 已有参与者身份
（`participants[].id/status` + `groupOrder` + speakerId 规则）。判断：
**PARTICIPANT_CONTRACT_DEFERRED** —— 当前没有任何多角色 Activity 的真实入口
（Cinema/Co-read 只绑定一个角色），因此 P26 现在**不必**解决；
但已登记为**未来复用 P24 参与者身份 vs Activity 自持**的开放问题（§32 Open Questions）。

**Runtime Feedback**（§22）：反馈不是单一概念，至少要分成四类：

| 类型 | 今天的实现 | 消费者 |
| --- | --- | --- |
| event delivery（把"发生了什么"投出去） | 不存在（Gap #1） | 域消费者（未来） |
| observation read（拉取"现在是什么"） | 已有（投影/域字段） | prompt 构造、UI |
| planner input（把状态喂给规划器） | 部分（`_activeTickAiPlans` 的上下文、nudge 的活动快照） | 规划器 |
| runtime wake-up（唤醒某个 runtime） | 部分（`_activeTick` 30s；companion 15s tick） | 域 tick |

⇒ **Runtime Feedback 是多个不同概念**，不能合并成一个"feedback layer"。
Middle Brain **本阶段不接线**，只登记为未来可能消费者。

**Feedback Loop Guard**（§23）：必须有 loop prevention requirements（仅需求）：
`causationId`（谁导致的）、`correlationId`（同一因果链）、`origin`（初始触发者）、
`depth`（链深上限）、`dedupe`（同一事实不重复消费）、`cooldown`（同域最小间隔）、
`consumer policy`（哪些消费者有权再触发动作）。
今天已有的**同类实践**：Active Message 的 `cancelIfNewerPlanExists` / 8 分钟 nudge 冷却 /
计划的 `maxAttempts`；Diary/Active 的 `candidateId` 幂等键 —— 说明"防环"在 IB 里是**域级策略**，
不是通用总线职责（本阶段只登记为 requirement）。

**Source Vocabulary**（§24）：选择 **B（每个 capability/domain version 自己定义 source）**：
**禁止**扩张全局 source enum；Role Letter 保持 `schedule | character`，
Diary `schedule|character|user`、Active Message `schedule|plan|character|user|companion` 均不变；
若 Activity 未来纳入 capability，只允许**域内版本化**词汇。

## 6. Browser / Node Symmetry Test（§25）

| 面 | 分类 | 依据 |
| --- | --- | --- |
| Active Message 发送权限（authority） | **CROSS_RUNTIME（同一份模块）** | P25-3C-Node：浏览器与 companion `require` 同一 `active-message-authority.js` |
| Active Message 交付事件（`events[]`） | **PERSISTED_CROSS_RUNTIME** | companion 持久化 + HTTP 轮询 + ACK + 浏览器镜像落库 |
| Moments / Diary / Role Letter | **LOCAL_ONLY（浏览器）** | 无 Node 面 |
| Activity / Cinema / Co-read | **LOCAL_ONLY（浏览器）** | 无 Node 面 |
| P23 delivery（队列/typing/cancel） | **LOCAL_ONLY（浏览器）** | Node 不参与交付队列 |
| P24 group runtime | **LOCAL_ONLY（浏览器）** | 群回合在浏览器 |
| Mobile Gateway 事件频道 | **PERSISTED_CROSS_RUNTIME（传输层）** | `NOTIFY_EVENTS` + `broadcastEvent`；事件不含正文，状态靠 `sync.changes` 拉取 |

**结论**：今天只有**一条**真正的跨运行时域事件通道（Active Message companion），
它自带 ACK 与持久化。P26 **不得默认**"所有事件都要跨进程"——
跨运行时是需要单独论证的属性（而且已有先例表明：跨运行时事件只做**通知**，状态靠拉取）。

## 7. Delivery / Group / Authority / Executor / Writer 边界

**P23 Delivery Boundary**（§26）：P23 五核负责"**已经产生**的消息如何按时间、顺序、模态、
语音交付进会话流"（队列 `queued→delivering→completed/cancelled/failed`、typing、cancel 保留已交付）。
P26 的事件/观察/反馈**不得**变成"Delivery Runtime v2"：

- 域事件描述"已发生的 effect"，**不**决定消息何时进入会话流（那是 P23 的职责）；
- 观察是 pull/投影，**不**进入交付队列；
- 反馈回传不得绕过 P23 直接向会话流写消息（chatMessages 的写入者仍是聊天域）。

**P24 Group Runtime Boundary**（§27）：P26 不重写 participation planner、speaker identity、
group turn、groupOrder、visibility、dynamic participation（全部属 P24 冻结范围）。
若未来"群活动"需要 P24，只登记为 **dependency**（P26 → P24），不复制其语义。

**Authority Boundary**（§29）：未来的 event / observation / session 机制**不得**让 authority 变成
state store / event store / scheduler / session manager / observer / feedback engine。
Authority 保持**只做 permission decision**（无状态、无 IO）。

**Executor Boundary**（§30）：**DOMAIN_EXECUTOR_MODEL_SUFFICIENT**。
依据：四个域的 executor 都是域内闭包（写入唯一 canonical writer），
没有任何当前证据要求全局 executor pool 或跨域执行协调（唯一跨运行时协作是
Active Message 的"浏览器镜像 companion 事件"，且已由同一 authority 收敛）。

**Canonical Writer Boundary**（§28）：事件机制**不得**成为第二个 writer。
Canonical Writer 仍然是 **domain state authority**；事件只能：
① 描述**已经发生**的 effect（附带 domain id 关联），或 ② 表达 lifecycle signal。
Event Bus **不得**直接持有业务数据（今天 Active Message 的事件也遵守这条：正文在 canonical 消息里，
事件是交付记录；Mobile Gateway 同样"事件不含正文"）。

## 8. Event Stress Tests

**Event Ordering**（§31）：

| 事件对 | 真的需要全局顺序？ | 需要的顺序边界 |
| --- | --- | --- |
| moment created ↔ active message sent | NO | 各自 per-domain |
| role letter written ↔ letter read/reply | NO（全局）/ YES（同 letter 的 per-entity） | per-entity（letter id） |
| activity progress ↔ activity progress | NO（全局）/ YES（同 session 的单调性） | per-session（activityId） |
| activity finished ↔ activity progress | YES（同一 session 内：finish 之后不应再有 progress 被当作有效） | per-session |
| P23 多单元消息 | 已有 `sequenceIndex`（per-turn） | per-turn |
| P24 成员回合 | 已有 `groupOrder`（per-groupTurn） | per-groupTurn |

⇒ **requirement：顺序只在 per-domain / per-entity / per-session / per-turn 范围内保证**；
**不得**直接选择 global sequence（无证据支持，且会与 P23/P24 既有身份冲突）。

**Event Persistence**（§32）：

| 事件/信号 | 必须持久？ | 依据 |
| --- | --- | --- |
| canonical mutation result（Active 的 sent/skipped/failed） | **YES（已有）** | companion 需要 ACK 与重放上次交付 |
| role letter / diary / moment 的"已发生"标记 | **NO（今天）** | canonical 行本身可读回 ⇒ 不需要额外事件日志 |
| typing / UI progress | **NO** | UI 瞬态 |
| frame（留影） | **NO** | request-local，不落库（既有断言 `Vision.frameNotPersisted`） |
| lifecycle signal（started/finished） | **FUTURE** | 今天无写入者；若未来需要"事后重建会话历史"再评估 |

⇒ **禁止"所有事件全部落库"**；持久化必须按语义（可重建性 + ACK 需求）逐项论证。

**Replay**（§33）：

| 场景 | 需要什么 |
| --- | --- |
| Browser 重启 | **从 canonical state 重建**即可（活动指针可重建；消息可读回；`activities` 记录在库）—— 不需要事件重放 |
| Node companion 重启 | 需要**自己的**状态文件（`active-message-service.json`）与未 ACK 事件（既有实现）—— 这是该域既有能力，不是通用需求 |
| UI reconnect | 需要 canonical state 拉取（今天已经这样做：`loadXxxPage` / `sync.changes`） |

⇒ **requirement：优先"canonical state 可重建"，不强行要求 event replay**。

**ACK**（§34）：

| 类别 | 实例 | 依据 |
| --- | --- | --- |
| FIRE_AND_FORGET | activity 内存回调、`IBApps.broadcast`、typing | 无持久化、无重投需求 |
| CONSUMER_ACK_REQUIRED | Active Message companion 事件 | 消费后才可丢弃（既有 `acknowledged` 字段） |
| DOMAIN_ACK | 计划状态机推进（`waiting_for_user` 等） | 域内状态推进 |
| TRANSPORT_ACK | Mobile Gateway 事件频道订阅（设备级） | 传输层 |
| NOT_APPLICABLE | 观察读取、投影 | 无投递语义 |

⇒ 默认 **FIRE_AND_FORGET**；只有"丢一次就会丢数据"的域才要求 ACK。

**Event Identity**（§35）：

| 字段 | 判定 | 依据 |
| --- | --- | --- |
| eventId | **REQUIRED**（若引入域事件） | 去重/审计的最小身份（Active 已有 `event_*`） |
| domain | **REQUIRED** | 事件必须知道自己属于哪个域（消费者按域订阅） |
| entityId | **REQUIRED**（指向 canonical 行） | 事件必须能关联到 canonical state |
| actorId | **OPTIONAL** | 只有"由谁触发"有意义时才需要（如 role letter 的 fromRoleId） |
| source | **OPTIONAL** | 与 actor 语义重叠；按域决定（P25 已用域内闭集） |
| timestamp | **REQUIRED** | 任何排序/新鲜度都要它 |
| causationId | **REQUIRED（若允许再触发）** | 防环（§5 Feedback Loop Guard） |
| correlationId | **OPTIONAL** | 跨域因果链（今天无证据强制） |

**Observation Freshness**（§36）：真需求只有三项 ——
**capturedAt**（观察何时取得，如 frame 的本轮时间）、**source**（观察来自哪个 entity/session）、
**availability**（当前是否可得，如 `null` / 空串 / `noTime`）。
`freshness` 的其它花哨语义（TTL、staleness 阈值）**今天无证据要求**；
**不实现统一 envelope**。

**Runtime Wake-up**（§37）：

| 事件/信号 | 分类 | 依据 |
| --- | --- | --- |
| role_letter.written | **NOTIFY_ONLY** | 今天只影响 UI（toast）与对方角色的回信队列（域内，不唤醒 agent） |
| moment.created | **OBSERVE_ONLY** | Moments 已有自主管道；事件本身不需要再唤醒 |
| active_message.sent | **NOTIFY_ONLY** | 交付结果通知（既有通知/镜像） |
| activity.progress | **NO_AGENT_EFFECT** | 观察数据，只进 prompt |
| activity.finished（若未来存在） | **WAKE_ELIGIBLE（未来）** | 可能促成"送别/回顾"，但今天无写入者，不成立 |

## 9. P26 Scope Candidate Table（§38）

| Candidate | Required now? | Evidence | Owner | P26? | Priority | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Domain Event Mechanism | YES（最小集合） | 无域事件；`emit` no-op；`broadcast` 仅当前 App | 无（各家局部） | YES | P1 | 只定义最小语义：identity / producer / consumer / per-domain ordering |
| Observation Layer | YES（登记与只读契约） | frame=request-local、progress/subtitle=域字段、context=投影 | 各域 + 未来公共登记点 | YES | P1 | **不经 authority**；只做 producer 登记与只读契约 |
| Session Runtime Contract | YES | `activities` 无 lifecycle；`finished` 无写入者 | Activity 域运行时 | YES | P1 | 只定义"谁是 session / 状态归谁 / 最小状态集合" |
| Resource Arbitration | YES（契约层，暂不实现仲裁动作） | 同角色并发活动；无 owner/lease/lock | 无 | YES | P1 | 只为未来 session 模型定义判据归属 |
| Participant Contract | DEFERRED | 今天 1:1；P24 有群参与者 | P24（群） | CONDITIONAL | P3 | 开放问题：复用 P24 还是 Activity 自持 |
| Runtime Feedback | CONDITIONAL | typing/小窗靠 broadcast + App 本地 | App / UI | CONDITIONAL | P3 | 必须拆成 event-delivery / observation-read / planner-input / wake-up 四类 |
| Source Vocabulary | CONDITIONAL | Activity 真实来源无法用现有闭集表达 | 各域自持 | CONDITIONAL | P3 | **域内版本化**；禁止全局枚举扩张 |
| Cross-runtime Transport | FUTURE | 仅 Active companion 与 Mobile Gateway 两条 | Active Message / Home Node | FUTURE | P4 | 不得默认所有事件跨进程 |
| Event Persistence | FUTURE（按语义分级） | Active 事件持久；其余不持久 | 各域 | FUTURE | P4 | 禁止"全部落库" |
| Event Replay | FUTURE | canonical state 可重建 | 各域 | FUTURE | P4 | 优先重建，不要求 replay |
| Event ACK | NOT_REQUIRED（除既有） | 只有 Active companion 有 ACK 需求 | Active Message | NO | — | 默认 fire-and-forget |
| Event Ordering | FUTURE（按域） | P23 `sequenceIndex` / P24 `groupOrder` 已足够 | P23 / P24 / 各域 | FUTURE | P4 | 禁止全局序 |

## 10. Hard vs Conditional Requirements（§39）

| 分类 | 条目 | 判据 |
| --- | --- | --- |
| **HARD_REQUIREMENT** | ① Domain Event Mechanism 的最小语义（identity / producer / consumer / per-domain ordering）；② Observation 层的登记与只读契约；③ Session Runtime Contract（session 身份 + 状态归属 + 最小状态集合）；④ Resource Arbitration 的**归属契约** | 由代码事实缺位直接推出（无位置、无契约、无写入者/无仲裁者） |
| **CONDITIONAL_REQUIREMENT** | ⑤ Participant Contract；⑥ Runtime Feedback 契约；⑦ 域内 Source Vocabulary | 只有当对应能力真的要做时才需要（今天多角色活动不存在；反馈仅 UI 局部；Activity 未纳入 capability） |
| **FUTURE_REQUIREMENT** | ⑧ Cross-runtime Transport；⑨ Event Persistence 分级；⑩ Event Replay；⑪ Event Ordering（按域） | 今天无证据要求；但一旦引入域事件，需要预先约定"按域决定"的原则 |
| **NOT_REQUIRED** | ⑫ Event ACK（除既有 Active companion）；exactly/at-least/at-most-once 的**通用**承诺；global sequence | 无产品事实强迫 |
| **OUT_OF_SCOPE** | 全局 state store / universal executor pool / scheduler 替换 / P23 替换 / P24 替换 / Memory 重写 / Middle Brain 重写 / 全局 source 或 decision 枚举 / 通用持久事件日志 | §41 非目标 |

## 11. MINIMAL_P26（§40）

**MINIMAL_P26 只能包含下面四件事（其余全部推到 conditional/future）：**

1. **Domain Event Mechanism（最小语义）**：定义"域事件"与"局部回调/UI 广播/传输通知"的区别，
   以及 **domain-owned event identity + producer/consumer 语义 + per-domain ordering 边界**；
   **不**定义 API、**不**承诺 delivery guarantee、**不**建 event log、**不**建 bus。
2. **Observation 的登记与只读契约**：定义"只读生产者/投影/新鲜度/来源/可用性"的最小契约，
   并明确 **observation 不经过 authority、不产生 canonical effect、不需要 verifier**；
   **不**实现统一 envelope。
3. **Session Runtime Contract**：定义"什么是 session（vs record / pointer / view / resource / transport）"、
   状态归属（**canonical domain state / runtime state / pointer / projection** 的分类）
   与**最小生命周期语义**；**不**搬动任何既有 state。
4. **Resource Arbitration 的归属契约**：定义"独占 vs 并存"的判据由谁拥有、留给谁扩展；
   **不**实现锁/租约/优先级/抢占。

**不在 MINIMAL_P26 内**：Participant Contract、Runtime Feedback 契约、域内 Source Vocabulary、
cross-runtime transport、event persistence/replay/ACK/global ordering。

## 12. P26 Non-Goals（§41）

- **No global state store**（状态仍归各域运行时）
- **No universal executor pool**（domain executor 已足够：DOMAIN_EXECUTOR_MODEL_SUFFICIENT）
- **No scheduler replacement**（既有 tick / companion 15s / 计划调度保持）
- **No P23 replacement**（delivery 五核冻结；事件≠交付）
- **No P24 replacement**（participation / speaker identity / groupTurn / groupOrder / visibility 不动）
- **No Memory rewrite**（只登记为读取边界与既有委托）
- **No Middle Brain rewrite**（本阶段不接线）
- **No global source enum**（域内版本化）
- **No global decision enum**（三个域权威仍是 ALLOW/DENY；Autonomy Core 的 DEFER 只属于它自己）
- **No universal persistent event log**（持久化按语义分级）
- **No exactly-once fantasy**（不承诺任何通用 guarantee）
- **No distributed-system architecture unless required**（跨进程只有已存在的两条通道）
- 附：**不把 chat delivery 塞进事件机制**；**不让事件机制成为第二个 writer**；
  **不让 authority 变成 state/event store、scheduler、session manager、observer 或 feedback engine**。

## 13. Candidate Architecture Shapes（§42）

只作为**候选形状**，不选 winner、不实现：

| 维度 | Shape A · Domain-local events + thin observer | Shape B · Shared event contract + domain emitters | Shape C · Runtime feedback layer |
| --- | --- | --- | --- |
| 形状 | 各域自己发"已发生"事件，另加一个极薄的观察登记点（只读） | 定义共享的域事件契约（identity/domain/entityId/timestamp/causationId），各域实现 emitter | 在上述之上再加一层"反馈"：把 effect/状态回传给规划器/runtime（含防环要求） |
| complexity | 最低（不新增共享运行时） | 中（共享契约 + 每域 emitter） | 最高（反馈策略 + 防环 + 可能的唤醒） |
| ownership | 完全留在域（observer 只登记） | 契约共享、实现仍在域 | 契约 + 反馈策略需要新归属 |
| cross-runtime need | 可完全本域（Active 已有自己的跨运行时通道） | 契约需说明"跨运行时可选" | 需要更强语义（唤醒跨进程） |
| persistence | 不要求 | 按域决定（默认不持久） | 需要反馈日志/去重状态（新持久面） |
| compatibility with P25 | 最好（不改 authority/executor/writer/verifier 语义） | 好（契约只描述 effect，不做 writer） | 需要额外 guard 防止 authority 变成 feedback engine |
| compatibility with Activity | 好（Activity 只需发 lifecycle/observation 信号） | 好（Activity 的 record/pointer 定位不变） | 中（需要 session 状态分类先落地） |
| 风险 | 各域事件语义可能再度漂移 | 共享契约过早冻结的风险 | 反馈回路 / 误唤醒 / 架构膨胀风险最高 |

## 14. Open Questions（§43）

留给 P26-1（本阶段不回答）：

1. 域事件是否需要**跨域消费者**，还是各域自有消费者即足够？
2. Observation 登记点放在哪一层才不破坏"域拥有状态"？
3. session 与 Activity 是**同一概念的两个面**，还是两个不同实体（Activity 是 resource + 会话）？
4. 多角色活动是否复用 P24 参与者身份，还是 Activity 自持 participants？
5. Runtime Feedback 的最小消费者集合是谁（UI？规划器？tick？），是否允许唤醒跨进程 runtime？
6. 若引入域事件，是否需要 `causationId` 强制（防环）与 per-domain 深度上限？
7. Activity 的未来命令是否需要域内 source 词汇版本化（`event` / `timer` / `user-open`）？
8. 事件持久化的判据（可重建性 vs ACK）如何在各域落地而不形成"通用日志"？

## 15. Final Answers（Q1–Q20，§51）

| # | 问题 | 答案 |
| --- | --- | --- |
| Q1 | P26 为什么存在？ | 因为 P25 解决了"想做什么 → 允许 → 执行 → canonical effect → verify"，但没有解决 **effect 之后**的事（谁需要知道 / 如何观察 / 如何反馈 / session 谁拥有 / 冲突谁仲裁） |
| Q2 | P26 最小硬需求是什么？ | §11 MINIMAL_P26 的四项：域事件最小语义、观察登记与只读契约、Session Runtime Contract、Resource Arbitration 归属契约 |
| Q3 | Event Bus 是否已经被证明必须？ | **没有**。代码事实没有任何"跨域订阅+路由+投递"的需求证据 |
| Q4 | 还是只证明了 Domain Event Mechanism？ | **是**：只证明了需要统一表达"域事实已发生"的最小语义 |
| Q5 | Generic Observation Layer 是否必须？ | **必须（登记与只读契约层面）**；但**不**需要 authority、writer、verifier 或统一 envelope |
| Q6 | Session Runtime Contract 是否现在必须？ | **必须**：Activity 只有 record + pointer，`finished` 无写入者，跨动作存续状态无契约 |
| Q7 | Resource Arbitration 是否现在必须？ | **现在不需要实现仲裁**（无真实冲突）；但**归属契约**是 P26 的最小需求之一 |
| Q8 | Participant Contract 是否现在必须？ | **DEFERRED**（今天 1:1；多角色活动无入口） |
| Q9 | Runtime Feedback 是否现在必须？ | **CONDITIONAL**：今天反馈只有 UI 局部实现；必须先把它拆成四类概念再谈契约 |
| Q10 | 哪些事件必须跨 Browser / Node？ | 只有**已经存在的** Active Message 交付事件（PERSISTED_CROSS_RUNTIME）；其余全部 LOCAL_ONLY |
| Q11 | 哪些事件必须持久？ | 只有"丢一次就丢数据"的：Active companion 交付结果（已有）；canonical mutation 本身靠行可读回 ⇒ 不需要额外事件日志 |
| Q12 | 哪些事件需要 ACK？ | 只有 Active companion 事件（既有 `acknowledged`）；其余默认 fire-and-forget |
| Q13 | 是否需要 replay？ | **不强制**：优先 canonical state 重建；仅"无法重建"的域需要（今天没有新增证据） |
| Q14 | 是否需要全局 event ordering？ | **不需要**：per-domain / per-entity / per-session / per-turn 已足够（P23/P24 已有域内序） |
| Q15 | Domain Executor 是否仍然足够？ | **足够**（DOMAIN_EXECUTOR_MODEL_SUFFICIENT） |
| Q16 | Authority 是否继续保持无状态？ | **是**（不得变成 state/event store、scheduler、session manager、observer、feedback engine） |
| Q17 | Canonical Writer 是否继续由 domain 持有？ | **是**：事件只能描述已发生的 effect 或 lifecycle signal，不能成为第二个 writer |
| Q18 | Observation 是否应绕过 Authority？ | **是**（默认绕过）；只有读取本身存在真实权限边界时（如 Memory/Moments 可见性）才需要授权 |
| Q19 | P23 / P24 与 P26 的边界是什么？ | P23 管"已产生消息的交付"，P24 管群回合的参与/身份/可见性；P26 只描述 effect 与观察，**不得**成为 Delivery v2 或改写 P24 |
| Q20 | P26-1 应该解决哪一个最小问题？ | **Domain Event Mechanism 的最小语义**（identity / producer / consumer / per-domain ordering），并同时给出 observation 登记点的边界；session/仲裁只定义归属契约，不实现 |
