# P25-3E · Runtime Gaps（压力测试结果 / P26 需求输入）

状态：**需求输入（requirements only）**，不是 P26 设计。
本文件不含 Event Bus / Observer / Session Manager / Resource Arbitration 的 API 设计或实现，
也不提出任何 enum 扩张。

前置：`docs/P25-3E-ACTIVITY-BOUNDARY-AUDIT.md`（事实审计 + 清单 + 分类表 + 放置表）。

---

## 1. Existing-Tree Placement Test（逐层判定）

判定规则（只用"现有结构能否容纳"作证据，不靠"应该有"）：

| 层 | 现有树里的判据 |
| --- | --- |
| Capability | registry 只登记 descriptor；**write/action 必须有 domain authority**，并有 canonical writer + verifier |
| Authority | 纯模块：candidate → decision（ALLOW/DENY）→ 仅 ALLOW 调 executor；**不持有状态、不做 IO** |
| Executor | 只执行已授权动作（不重判权限） |
| Canonical Writer | "一个动作 → 一个 canonical effect"（唯一写点 + 可验证的行） |
| Verify | 只读校验 canonical 行存在（不补写、不 retry） |
| Observation | **当前不存在**独立观察层（P25-3A 只有 Intent/Observe → Plan，其中 Observe 是 planner 的输入构造，不是运行时观察生产者） |
| Existing Event Mechanism | 内存回调（`IB.activity.on/off`）+ 应用广播（`IBApps.broadcast`）+ 持久事件队列（Active Message，属另一个域） |
| Domain Runtime | 域自己持有状态与生命周期（如 `IB.activity` / Moments / Diary / Active Message 的运行时） |

逐原语放置理由（与主文档分类表一一对应）：

| Primitive | 放置 | 理由（证据） |
| --- | --- | --- |
| activity.create | FITS_CAPABILITY | 单写（`dbPut('activities')`）+ 可 verify（按 id 读回）；缺的只是"没有 authority"（本阶段不新增） |
| activity.save / activity.progress | FITS_CAPABILITY | 同上：单写 + 可验证（`saveActivity` / `setProgress` 各一次 `dbPut`） |
| activity.delete | FITS_CAPABILITY | 单删 + 可验证（`dbDelete` + 指针清理；指针清理是 runtime 副作用，见下） |
| activity.read.* / context.build | FITS_DOMAIN_RUNTIME | 纯读/投影，无 side effect ⇒ 不需要 authority/writer/verify |
| activity.current.set/clear/resolve | FITS_DOMAIN_RUNTIME | 指针在 localStorage、被 runtime 自述为"不是 authority"；它是运行时状态而不是 canonical effect |
| activity.send | FITS_DOMAIN_RUNTIME | 它**不产生自己的 canonical effect**，而是委托聊天链路（`sendChatMessage`）；活动只携带 `activityId` / `visionReference` |
| activity.memory.write | FITS_DOMAIN_RUNTIME | 委托 Memory 域（`quickCreateMemory`）；canonical effect 在 Memory 域 |
| activity.nudge | FITS_DOMAIN_RUNTIME | 委托 Active Message 计划域（`_activeSaveAiPlan`）；plan 的 authority 属 P25-3C |
| activity.openChat / fav / event.subscribe | FITS_UI_EFFECT / FITS_EXISTING_EVENT | UI 导航、收藏、内存回调订阅；无 canonical effect |
| activity.mark | **NO_CURRENT_HOME** | 它想表达的是"域事件"（开始/结束分隔），但实现是**直接写 `chatMessages`** 且没有事件身份/持久身份/消费者；生产无调用者（证明见 §7） |
| cinema.play/pause/seek | FITS_UI_EFFECT | 媒体传输控制（`IBMedia` adapter），不是活动生命周期 |
| cinema.progress / subtitle | FITS_DOMAIN_RUNTIME | 写进 `activities.progress`（单写、可读回）—— 属运行时状态字段，不是独立观察通道 |
| cinema.frame | FITS_OBSERVATION | request-local 观察（`visionReference`），**不落库**；它需要的是"观察"语义（无 canonical writer） |
| cinema.nudge / coread.nudge | FITS_DOMAIN_RUNTIME | 同 `activity.nudge` |
| activity.finish/pause/resume/join/leave/suspend/interrupt | **NOT_PRESENT** | 生产代码里没有实现（也不存在状态写入者） |
| presence.observe / timeline.observe | **NOT_PRESENT** | 仓库里不存在（同名标识符属于 Mobile Gateway / 卡牌名，与 Activity 无关） |
| activity.session.ownership | **NO_CURRENT_HOME** | 资源归属/排他/仲裁在现有树里没有位置（证明见 §7） |
| activity.event.* | **NO_CURRENT_HOME** | 域事件在现有树里没有位置（证明见 §7） |

## 2. Single-Write Model Stress Test（§10）

P25 模型：`Candidate → Authority → Executor → Canonical Writer → Verify`。
逐原语测试（不存在的不假造）：

| 动作 | 生产是否存在 | 能否装进"一个动作 → 一个 canonical effect → 一次 verify" |
| --- | --- | --- |
| start | **PARTIAL**：`createActivity` + `setCurrent` | **不能一次装完**：create 是一次 canonical 写（可 verify），但"开始"在现实里还包含**localStorage 指针写**（第二个 home，且 runtime 自述它不是 authority） |
| continue | **PARTIAL**：`setProgress`（1 写 ✓）/ `send`（委托聊天） | `setProgress` 装得下；`send` 的 canonical effect 属聊天域（Activity 只是参数） |
| join | **NOT PRESENT** | — |
| leave | **NOT PRESENT** | — |
| pause | **NOT PRESENT（活动级）**；`cinema.pause` 是媒体传输 | 媒体暂停是 UI/传输命令，不需要 authority |
| resume | **NOT PRESENT** | — |
| end | **NOT PRESENT**（没有 `finish` 写入者；最接近的是 `clearCurrent` 指针清理 + `deleteActivity` 删除） | 删除装得下（单删 + verify）；"结束会话"作为**状态迁移**装不下（没有状态机、没有事件） |

**结论**：Activity **可以被拆成若干单写 command**（create / progress / save / delete），
每一条都能单独进入 P25（前提是将来有 authority）；
但存在**无法拆解的持续 runtime state**：current 指针、并发会话、生命周期、参与者集合、资源归属 ——
它们不是"一次动作"，也不产生"一个 canonical effect"。

## 3. Decision Vocabulary Stress Test（§11–§15）

严格区分三者（**不得混为一个 enum**）：

| 概念 | 含义 | 当前实现位置 |
| --- | --- | --- |
| Authority Decision | 允许/拒绝某个动作 | 各 domain authority（`{ALLOW,DENY}`）；Autonomy Core 另有 `DEFER`（仅它自己） |
| Runtime Lifecycle Transition | 会话/活动状态迁移 | **NOT PRESENT**（只有 `status:'active'`，没有写入者写 `finished`） |
| Scheduling | 何时（稍后/排队）执行 | Active Message 计划（`scheduledAt` + 15s tick）与 App 本地定时器（Cinema 闲置 nudge） |

### DEFER 分析（§12，四个 Case）

| Case | 场景 | 结论 | 依据 |
| --- | --- | --- | --- |
| A | 用户请求开始 Cinema，但角色"正在另一个 Activity" | **runtime/scheduler concern（不是权限）** | 生产允许同角色并发活动（smoke T6 建了两个 active）；没有排他、没有冲突检测 ⇒ 没有"需要等待的许可"这回事 |
| B | 角色自主请求 Activity，资源暂时被占用 | **runtime concern** | 不存在资源占用/租约/锁；`findActivity` 只做"同资源复用" |
| C | 活动执行中出现高优先级 interruption | **NOT PRESENT** | 没有 interruption/preemption 语义；P25-3A 的 `isCancelled` 只作用于"后续 step 不执行" |
| D | 活动未开始，未来可以执行 | **scheduling concern** | 现实实现就是"延迟的计划"（`nudge` → Active Message plan 的 `scheduledAt`） |

⇒ **不新增 DEFER**：四个 Case 都不能推出"Authority 需要一个第三种决定"，
它们分别落在 runtime / scheduling（而 scheduling 已有域：Active Message 计划 + tick）。

### PAUSE / SUSPEND（§13）

`pause` 不是 permission，也不是（今天的）lifecycle transition：
它是**媒体传输控制**（`IBMedia` adapter 的 `pause`）与 **NOT PRESENT 的活动状态**。
把 pause 做成 authority decision 会把"传输"误建模成"许可"。

### Queue（§14）

**不需要 Activity Queue**：现有"延迟执行"已经有两个归属 ——
Active Message 的计划（跨域、持久、可取消）与 App 本地定时器（UI 级）。
若未来出现"必须串行化的会话资源"，那是 **scheduler/资源仲裁** 需求（P26 输入），
而不是现在能凭空加的 queue。

### Verdict（§15）

**CURRENT_DECISION_VOCABULARY_SUFFICIENT**（就今天存在的 Activity 动作而言）：
没有任何已实现路径需要第三种决定；缺的不是 decision verb，而是
**Runtime Lifecycle** 与 **Scheduling/仲裁**（两者都不是 decision enum 的成员）。

## 4. Source Vocabulary Stress Test（§16–§18）

### 真实 trigger source（只按代码事实）

| 候选 source | 是否存在 | 证据 |
| --- | --- | --- |
| user | **YES** | `cinema.open` / `coread.open` 由用户点击进入；`#ci-mem` / `#mem` / `#ci-nudge` 也是用户点击 |
| character | **PARTIAL** | 角色不直接创建活动；`nudge` 生成的**计划**由 Active Message 域以 `source:'ai_planned'` 执行（活动域本身没有"角色发起"入口） |
| schedule | **NO（Activity 域）** | 活动不被 tick 驱动；`_activeTick` 里没有 activity tick |
| event | **NOT PRESENT** | 没有任何"letter written / moment posted / message received / group event → 创建或推进 Activity"的链路（§14 专项审计） |
| group_runtime | **NOT PRESENT** | 群聊与 Activity 零交叉（`group-runtime-core.js` 无 activity 引用） |
| system | **PARTIAL** | Cinema 本地闲置定时器（120s）会触发 `nudge`（UI 级定时器，不是域调度） |

### Verdict（§17）

**ACTIVITY_REQUIRES_DOMAIN_SOURCE_VERSIONING**（若将来要把 Activity 动作纳入 P25）：
Activity 的真实来源（用户打开 App / UI 定时器）无法用现有各域的闭集表达；
**但本阶段不实现、也不扩张任何全局/其它域的 source**：

- Role Letter 闭集保持 `['schedule','character']`（守卫 A6）；
- Diary / Active Message / Moments 的闭集与 Foundation 的 `ORCHESTRATION_SOURCES` 逐字保持（守卫 A5/A7）；
- 将来若需要，只允许**域内版本化**的 source 词汇（例如 activity 域自己的闭集），不得改公共枚举。

### Event Source 专项审计（§18）

**EVENT_SOURCE = NOT PRESENT**。逐条核对：

| 候选事件 → Activity | 现状 |
| --- | --- |
| letter written → 活动 | 不存在（`role-letters.js` 不引用 activity） |
| moment posted → 活动 | 不存在（`moments.js` 只读 `_rlMemoriesFor`/`_rlMemBlock`，不碰 activity） |
| message received → 活动 | 不存在（`communication.js` 只**读**活动上下文并打 `metadata.activityId`） |
| group event → 活动 | 不存在 |
| 活动 → 其它域 | 只有三个**明确委托**：`writeMemory`（Memory 域）、`nudge`（Active Message 计划域）、`fav`（收藏域） |

## 5. Observer Stress Test（§19）

| 观察对象 | 是否经过 Authority | 是否产生 side effect | 是否需要 canonical writer | 是否只是读/投影 | 是否持续产生数据 | 放置 |
| --- | --- | --- | --- | --- | --- | --- |
| cinema.frame（留影帧） | NO | NO（request-local，随本轮请求发出，不落库） | NO | 是（一次性观察） | NO（用户手动触发） | **FITS_OBSERVATION** |
| cinema.progress（播放进度） | NO | YES（写 `activities.progress`，1.5s 节流） | 已有（域内单写） | 兼顾（写状态 + 读投影进 prompt） | YES（持续、被节流） | FITS_DOMAIN_RUNTIME |
| cinema.subtitle（字幕切片） | NO | YES（随 progress 写入最近 N 条） | 同 progress | 是（本地 `.srt` 解析后的投影） | YES（随进度刷新） | FITS_DOMAIN_RUNTIME |
| coread.page / pageText / recap | NO | YES（`setProgress`） | 同 progress | 兼顾 | YES（翻页时） | FITS_DOMAIN_RUNTIME |
| presence | — | — | — | — | — | **NOT_PRESENT** |
| timeline | — | — | — | — | — | **NOT_PRESENT** |

**结论**：观察类数据**不应经过 Authority**（它们不是许可问题，也没有"允许观察"这种产品语义），
也不需要独立 canonical writer —— 它们要么落在**域运行时的既有字段**（progress/subtitle），
要么是**请求内一次观察**（frame）。真正的缺口不是"观察产生者"，
而是**没有统一的观察层**（无法登记"只读生产者 / 投影 / 反馈"），因此
`frame` 与未来的 presence / timeline 只能挂在 App 本地（FITS_OBSERVATION）或域字段上。

## 6. Session State / Resource Ownership Stress Test（§20–§21）

### 谁拥有 state

| state | 位置 | 性质 |
| --- | --- | --- |
| 活动记录（type/roleId/resourceId/progress/bookmarks/status/timestamps） | IndexedDB `activities` | **persisted（canonical-ish 域数据）** |
| current（每角色一个） | localStorage `ib_activity_current_v1` | **pointer（可重建，runtime 自述"不是 authority"）** |
| App 内 `_activity` / `_aiId` / `subs` / `media adapter` | App IIFE（内存） | **runtime-only** |
| 本轮活动（每回合最多一个） | `resolveActivity` 的返回值 | **derived projection** |

**Authority 是否持有 state**：不持有（今天也没有 Activity Authority）。
**这是正确边界，不是 gap**：P25 的 authority 是纯裁决（无状态、无 IO），
状态属于域运行时；把 state 移进 authority 会同时破坏"纯模块"与"可重建指针"两条既有约束。

### 资源竞争

| 问题 | 事实 |
| --- | --- |
| Cinema / Co-read / Voice 是否竞争资源 | 不竞争：三者各自独立（Voice 属 P23 交付域，与活动无引用）；Cinema 与 Co-read 之间也没有互斥 |
| 是否允许同时存在 | **允许**（同角色可有多条 `status:'active'`；smoke T6 建了两条） |
| 是否存在 exclusive current activity | 只有"指针指向哪一个"的**选择**，没有"只能有一个活动"的**约束** |
| 冲突时谁裁决 | **无人裁决**：`findActivity` 只做同资源复用；不同资源并行存在，指针按"最近活跃"选一个 |

**结论**：资源归属/排他/仲裁 = **NO_CURRENT_HOME**（既不是 authority 的职责 —— 它是策略不是许可；
也不是 scheduler 的职责 —— 它不需要"何时"，而是"谁"）。

## 7. NO_CURRENT_HOME Proofs（§9 格式）

### Primitive: `activity.session.ownership`（RESOURCE_OPERATION）

```
Capability:      NO
Reason:          registry 只登记"动作能力"；"所有权/排他"不是动作，没有 candidate、没有 executor、
                 也没有可 verify 的 canonical effect（活动记录本身就是资源，不是"写入结果"）。
Authority:       NO
Reason:          authority 是纯裁决层（无状态、无 IO）。资源归属需要**持有**"谁占用"的状态并跨动作存活，
                 这正是 authority 被禁止做的事（P25-3A/3B/3C/3D 一致约束）。
Executor:        NO
Reason:          executor 只执行已授权动作；这里没有可执行动作（没有 acquire/release 实现，也没有调用者）。
Canonical Writer: PARTIAL
Reason:          `activities` 里能写 `lastActiveAt`/`progress` 等字段，但**没有任何字段表达"所有权/租约"**；
                 写入它等于新增存储语义（本阶段禁止 DB migration）。
Verify:          NO
Reason:          无法定义"所有权成立"的可读判据（没有 owner 字段、没有版本、没有租约时间）。
Observation:     NO
Reason:          归属不是观察数据，而是需要被其它动作**查询并遵守**的约束。
Domain Runtime:  PARTIAL
Reason:          今天的"事实所有权"由 current 指针 + App 行为隐式实现（每角色一个指针、App 打开即 setCurrent），
                 但没有任何 API/状态能被其它域读取来"遵守"它（`resolveActivity` 只是投影）。
Existing Event Mechanism: NO
Reason:          内存回调只在本页面内、只对订阅者生效，无法承载"仲裁结果"这种跨动作约束。
Conclusion:      NO_CURRENT_HOME
```

### Primitive: `activity.event.started`（DOMAIN_EVENT，其他同类事件同证）

```
Capability:      NO
Reason:          事件不是动作能力：没有 candidate/authority/executor 的语义，也没有"是否允许发出"的权限含义。
Authority:       NO
Reason:          "允许开始一个活动"与"发出 started 事件"是两件事；把事件塞进 authority 会把
                 运行时事实（已经发生）误建模成许可（尚未发生）。
Executor:        NO
Reason:          executor 执行的是 domain 写入，不是"通知"。
Canonical Writer: NO
Reason:          今天唯一近似实现是 `mark()` 直接写 `chatMessages`（把事件伪装成聊天消息），
                 没有事件身份、没有 phase 消费者、生产无调用者 ⇒ 不能作为事件 writer。
Verify:          NO
Reason:          没有"事件是否成立"的 canonical 判据（无事件表、无 sequence、无 ack）。
Observation:     PARTIAL
Reason:          可以把事件视为观察流，但当前没有任何观察层可登记它（见 §5）。
Domain Runtime:  PARTIAL
Reason:          runtime 有 `_emit(id,ev,payload)` 与 `on/off`，但它是**同进程内存回调**：
                 无持久化、无跨标签页、无顺序保证，且 `api.emit` 是显式 no-op ⇒ 无法作为域事件出口。
Existing Event Mechanism: PARTIAL
Reason:          `IBApps.broadcast('turn'|'message')` 是**UI/传输**事件（给小窗/typing 用），
                 不是域事件；Active Message 的事件队列属另一个域（不同 store、不同消费者语义）。
Conclusion:      NO_CURRENT_HOME
```

### Primitive: `activity.mark`（DOMAIN_EVENT 的现状实现）

```
Capability:      NO          Reason: 不是能力，是"把标记塞进聊天流"的权宜实现。
Authority:       NO          Reason: 标记的合法性不构成许可问题（它没有跨域副作用）。
Executor:        NO          Reason: 无调用者、无授权链。
Canonical Writer: NO          Reason: 直接 `dbPut('chatMessages', {mark:{...}})` 会绕过聊天域的
                              canonical 写入语义（P23/communication 的落库路径）。
Verify:          NO          Reason: 没有"标记消息"的读回契约与消费者。
Observation:     PARTIAL   Reason: 语义上更像观察/事件。
Domain Runtime:  PARTIAL   Reason: 定义在 runtime 内，但生产无调用者（dead-but-exported）。
Existing Event Mechanism: PARTIAL Reason: 依赖聊天消息作为"事件载体"，与事件语义不符。
Conclusion:      NO_CURRENT_HOME（保留为导出 API，本阶段不动）
```

## 8. Existing Event Mechanism Audit（§22）

| 机制 | 位置 | 分类 | 事实 |
| --- | --- | --- | --- |
| `IB.activity.on/off/_emit` | activity-runtime.js | **LOCAL_CALLBACK** | 同页面内存回调；`api.emit` 显式 no-op；无持久化/跨页/顺序保证 |
| `IBApps.broadcast('turn'/'message')` | communication.js → apps | **UI_EVENT / TRANSPORT_EVENT** | 页面内应用间广播（Cinema 订阅并按 `activityId` 过滤、驱动 typing） |
| `window` DOM 事件（online / visibilitychange） | active-diary.js 等 | **UI_EVENT** | 浏览器事件，不是域事件 |
| Active Message 事件队列（`events` + history + `/events` 拉取 + ACK） | services/active-message-service.js / active/scheduler.js | **PERSISTED_EVENT**（**属于 Active Message 域**） | 有持久化、有 ACK、有跨进程传输；语义是"发送结果交付"，不是通用域事件总线 |
| `proactive-interaction-core`（语音呼入交互事件） | localStorage `ib_active_interactions_v1` | **PERSISTED_EVENT**（Active Message 的 `voice_call` 计划） | 有 `normalizeEvent`/`isDuplicateEvent`/`purgeExpired`，属于该计划而非 Activity |
| Activity 域事件（started/finished/joined/left/paused/progressed） | — | **NOT PRESENT** | 没有事件、没有状态写入者 |

**结论**：仓库里"存在事件" ≠ "已经有 Event Bus"。
现有机制要么是**本页内存回调**，要么是**某个域的持久事件队列**（Active Message），
没有通用的域事件总线；Activity 域**没有任何**域事件。

## 9. Gap Table（§34）

| Gap | Evidence | Why P25 cannot currently own it | Required concept | P26 input? |
| --- | --- | --- | --- | --- |
| 会话结束 / 生命周期迁移 | 生产无 `finish/end` 写入者；`status:'finished'` 只有测试写入（T8）；读侧 5 处判 finished | P25 只有"一次动作 → 一个 canonical effect"；生命周期是**跨动作存续**的状态机 | Session Lifecycle（状态集合 + 迁移规则） | YES |
| 资源归属 / 排他 / 仲裁 | 同角色可并发多活动（smoke T6）；无 owner/租约/锁；`findActivity` 只做同资源复用 | authority 无状态、不做 IO；scheduler 只回答"何时" | Resource Ownership / Arbitration | YES |
| 域事件（started/finished/joined/left/paused/progressed） | 无事件表、无写入者；`_emit` 是内存回调、`api.emit` 是 no-op | 事件不是动作能力；也没有持久/顺序/ACK 语义可 verify | Domain Event mechanism | YES |
| 观察层（frame / presence / timeline） | frame 是 request-local；presence/timeline 不存在 | 观察没有 side effect，不需要 authority/writer/verify；但没有"只读生产者"的登记位置 | Observation Layer | YES |
| 参与者模型（多角色 / 用户） | 活动只有 `roleId`（1:1）；无 participants / join / leave | 现有 candidate 契约面向"单主体动作"，没有集合语义 | Participant / Multi-party Session Contract | YES |
| 运行时反馈（UI 状态 → 其它消费者） | typing 由 App 本地 + `IBApps.broadcast` 驱动；活动状态变化不广播给其它域 | 反馈是 UI/传输事件，不是 domain effect | Runtime Feedback contract | YES |
| 域内 source 词汇 | Activity 的真实来源是"用户打开 App / UI 定时器"，现有各域闭集都无法表达 | 公共 source 是各域自持的闭集，禁止全局扩张（守卫 A7） | Domain-scoped source versioning（若将来要做 capability） | YES（条件性） |
| `mark()` 事件式写入 chatMessages | 直接 `dbPut('chatMessages')`，生产无调用者 | 绕过聊天域 canonical 写入语义 | （由 Domain Event mechanism 覆盖） | YES（同上） |

**不设计解决方案**：以上只列"缺口 + 证据 + 需要的概念"，不定义 API/状态机/存储。

## 10. Vocabulary Table（§35）

### Authority Decision

| 值 | 状态 | 依据 |
| --- | --- | --- |
| ALLOW / DENY | **PRESENT** | 四个 domain authority（Moments / Diary / Active Message / Role Letter）都是 `{ALLOW,DENY}` |
| DEFER（Authority Decision） | **NOT REQUIRED**（对已实现的 Activity 动作） | 四个 Case 全部落在 runtime/scheduling（§3） |

### Runtime Lifecycle

| 值 | 状态 |
| --- | --- |
| IDLE / STARTING / ACTIVE / PAUSED / ENDING / ENDED | **NOT PRESENT**（只有 `status:'active'`，且无任何写入 `finished` 的路径） |
| 一句话最小实现现状 | "打开即 active、退出即清指针"，没有显式生命周期 |

### Scheduling

| 值 | 状态 | 依据 |
| --- | --- | --- |
| IMMEDIATE | **PRESENT**（活动由用户打开，立即创建） | `cinema.open` / `coread.open` |
| DEFERRED | **PRESENT（在别的域）** | Active Message 计划 `scheduledAt` + `nudge` 的延迟 |
| QUEUED | **NOT PRESENT** | 没有 Activity queue（§3 Queue 分析） |

### Source

| 值 | 状态 |
| --- | --- |
| user | **PRESENT**（打开 Cinema / Co-read、点击留影/记忆/nudge） |
| character | **PARTIAL**（角色只能通过 Active Message 计划间接行动；活动域无 character 入口） |
| schedule | **NO（Activity 域）**（活动不被 tick 驱动） |
| group_runtime | **NOT PRESENT**（零交叉） |
| system | **PARTIAL**（Cinema 本地 UI 定时器触发 nudge） |
| event | **NOT PRESENT**（没有事件 → 活动链路） |

## 11. P26 Requirement Inputs（§23/§24）

以下只是**需求**（requirements），不是设计，也不含任何 API/状态机/存储提案：

1. **Observation Layer（观察层）**：需要能登记"只读生产者 / 投影 / 反馈"（frame、future presence、timeline），
   并明确它们**不经过 authority、不产生 canonical effect、不需要 verify**。
2. **Domain Event mechanism（域事件机制）**：需要能表达"已发生的域事实"（started / finished / joined / left /
   paused / progressed），并明确它与 Authority Decision、Lifecycle Transition、Scheduling 的关系；
   现有内存回调与 `IBApps.broadcast` 都不满足（无持久化/顺序/ACK）。
3. **Session Runtime Contract（会话运行时契约）**：需要定义"哪些状态属于域运行时、哪些属于指针、
   哪些属于投影"，以及生命周期的最小状态集合（今天只有 `active`，`finished` 无写入者）。
4. **Resource Arbitration（资源归属/仲裁）**：需要定义"独占 vs 并存"的判据与仲裁者（今天无人裁决）。
5. **Participant / Multi-party Session Contract**：若未来出现多角色或用户参与的活动，需要参与者集合语义
   （今天是 1:1 `roleId`）。
6. **Runtime Feedback contract**：需要定义活动状态如何反馈给 UI 与其它消费者（今天靠 `IBApps.broadcast` + App 本地状态）。
7. **Domain-scoped source vocabulary（条件性）**：若将来要把 Activity 动作纳入 P25，需要**域内**来源词汇
   （不得扩张公共枚举）。

**非目标（本阶段明确不回答）**：Event Bus 最终 API、Observer API、Session Manager API、
Runtime Feedback API、P26 架构最终形状、任何 enum/registry 变更。

## 12. Final Answers（Q1–Q14）

| # | 问题 | 答案 |
| --- | --- | --- |
| Q1 | Activity 是第五个 capability 吗？ | **不是**。它是一个域运行时；只有其中少量单写命令（create/progress/save/delete）形态上符合 capability |
| Q2 | 是否应拆成 command + runtime + observation？ | **是**（作为结论允许的形态）：command 部分是单写、可 verify；session/runtime 部分无法拆成单写；观察部分不需要 authority |
| Q3 | P25 single-effect model 能覆盖哪些部分？ | `activity.create` / `activity.progress` / `activity.save` / `activity.delete`（+ 将来的 finish/end 若定义为单写状态迁移）；`coread.page` / `coread.bookmark` 同形；`send` 的 canonical effect 属聊天域 |
| Q4 | 哪些部分 NO_CURRENT_HOME？ | session ownership/仲裁、域事件（started…progressed）、`mark()`、以及"通用观察层"（frame/presence/timeline 的登记位置） |
| Q5 | ALLOW/DENY 是否足够？ | **就今天存在的动作足够**（没有实现需要第三种决定）；缺的是生命周期与调度，不是 decision verb |
| Q6 | 是否真的需要 DEFER？ | **没有证据需要**：Case A–D 都是 runtime/scheduling concern（§3） |
| Q7 | PAUSE 是否属于 Authority？ | **不属于**：媒体 pause 是传输控制，活动 pause 是 NOT PRESENT |
| Q8 | 是否真的需要 Queue？ | **不需要** Activity queue；延迟执行已有归属（Active Message 计划 / App 定时器） |
| Q9 | 是否需要新的 source vocabulary？ | **条件性需要**：若要纳入 P25 需要**域内**词汇；**不得**扩张全局或其它域的闭集 |
| Q10 | event source 当前是否真实存在？ | **NOT PRESENT**（letter/moment/message/group 都不触发 Activity） |
| Q11 | 只读 observer 当前应该挂在哪里？ | 域运行时字段（progress/subtitle）+ 请求内参数（frame）+ UI；**通用观察层 = NO_CURRENT_HOME** |
| Q12 | session state 当前由谁拥有？ | **域运行时**（`activities` 持久 + `ib_activity_current_v1` 指针 + App 内存）；authority 不持有 state（正确边界） |
| Q13 | 现有 Activity event mechanism 是否足以称为 Event Bus？ | **不是**：`on/off/_emit` 是内存回调且 `emit` 是 no-op；`IBApps.broadcast` 是 UI/传输事件 |
| Q14 | P26 最小需求是什么？ | Observation Layer · Domain Event mechanism · Session Runtime Contract · Resource Arbitration（+ 参与者/反馈/域内 source 词汇；§11） |

## 13. Guards（本阶段的静态不变式）

见 `tests/test_p25_3e_activity_boundary_audit.js`（A1–A15）：清单完整 / 分类闭集与文档一致 /
未注册 activity capability / 无 Activity Authority / Foundation 逐字节 / Role Letter source 未变 /
无全局 source 扩张 / 无 decision enum 扩张 / 无 Event Bus / 无 queue / 无 session manager /
P23 未变 / P24 未变 / M1 Activity runtime 未变 / 无 DB migration。
**本阶段 production code changed = 0。**
