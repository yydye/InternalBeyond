# P26-0 · Runtime Architecture Map（当前架构 + 缺口地图）

状态：**CURRENT ARCHITECTURE + REQUIREMENT MAP**。
本文件**只画今天存在的结构**（CURRENT ARCHITECTURE）与**只画缺口**（REQUIREMENT MAP）；
不画最终 P26 架构，不做 design freeze。

**Production code changed = 0。**

---

## 1. Phase 0 · Existing Architecture Inventory（A–U）

每一项按 §5 要求的 12 个属性回答：Owner / Stateful / Persisted / Side-effecting / Cross-domain /
Ordering / ACK / Retry / Identity / Canonical / Producers / Consumers。

| # | 机制 | Owner | Stateful | Persisted | Side-effecting | Cross-domain | Ordering | ACK | Retry | Identity | Canonical | Producers → Consumers |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | Capability Registry（`agent-capability-registry.js`） | P25-3A | NO（纯数据） | NO | NO | YES（跨域枚举） | 稳定枚举（按 id 排序） | N/A | N/A | capability id | NO（只存 metadata + binding key） | adapter 注册 → 编排层查询 |
| B | Orchestration Core（`agent-orchestration-core.js`） | P25-3A | NO（纯函数） | NO | NO | YES | 拓扑序（`planStepsInOrder`） | N/A | NO（side effect 不重试） | planId / stepId | NO | planner → `runAgentPlan` |
| C | Domain Authority（moments mutation / autonomy / diary / active-message / role-letter） | 各域 | NO（纯裁决） | NO | NO | 单域 | N/A | N/A | NO | candidateId（确定性派生） | NO（只裁决） | domain 运行时 / 编排 adapter → executor |
| D | Domain Executor | 各域 | NO | 部分（写库） | YES | 单域 | N/A | N/A | 由调用方决定（域内既有 retry 只覆盖生成） | 由域定义 | **YES（唯一 canonical 写入）** | authority → canonical writer |
| E | Canonical Writer | 各域 | NO | YES | YES | 单域 | 写入顺序由域决定 | N/A | NO | domain id（`diary_*`/`rletter_*`/`active_msg_*`/moment id） | **YES** | executor → store |
| F | Verifier（diary / active-message / role-letter） | 各域 adapter | NO | NO（只读） | NO | 单域 | N/A | N/A | NO | 被验证行的 id | 读 canonical 行 | 编排层 / 测试 |
| G | Domain Runtime（`IB.activity` / Moments / Diary / Active / Letters / P23 delivery runtime） | 各域 | **YES** | 部分 | 部分 | 部分 | 域内确定（如 delivery 的 sequenceIndex） | 部分（Active companion 事件有 ACK） | 部分 | 域内 id | 由域的 writer 决定 | UI / 调度器 / 聊天侧 |
| H | Runtime-only state（Cinema `_activity/_aiId/subs/media adapter`；Co-read `_pages/_pi`；P23 队列 in-memory） | App / 域运行时 | YES | **NO** | NO | NO | 域内 | N/A | N/A | 无（内存对象） | NO | 同进程消费者 |
| I | Persisted domain state（`moments` / `diary_entries` / `active_message_*` / `roleLetters` / `roleLetterMemories` / `activities` / `chatMessages` / `memories` …） | 各域 | YES | **YES** | YES | 否（各自 store） | 由域决定 | N/A | N/A | 行 id | 该域的 writer 是唯一写入者 | 全域读取 |
| J | Pointer / projection（`ib_activity_current_v1`；`resolveActivity` 结果；`getActivityContext` 文本） | Activity 运行时 | pointer YES / projection NO | pointer YES / projection NO | NO | 单域 | 确定性优先级（0–4） | N/A | N/A | activityId | **NO（自述"不是 authority"）** | App 打开 → 每回合解析 → 聊天上下文 |
| K | Callback（`IB.activity.on/off/_emit`；`IBApps` 的 `ctx.on`） | Activity / AppStore | NO | NO | NO | NO | 调用顺序=注册顺序 | NO | NO | 无 | NO | 同页面订阅者 |
| L | DOM Event（`online` / `visibilitychange` / pointer 等） | 浏览器 | NO | NO | NO | NO | 浏览器保证 | NO | NO | 无 | NO | 页面内监听器 |
| M | `IBApps.broadcast` | AppStore | NO | NO | NO | NO | 注册顺序 | NO | NO | 无 | NO | 宿主 → **当前打开的 App**（`if(!_activeId)return`） |
| N | Active Message persisted events（`events` + `history` + `/events` 拉取 + ACK） | Active Message 域（Node companion + 浏览器镜像） | YES | **YES** | YES | 跨运行时（HTTP 轮询） | 有 `run_id`/`event.id`，消费顺序由轮询决定 | **YES（ACK）** | 有限（计划 `maxAttempts`） | `event.id` / `run_id` / `message_id` | events 是该域的**交付记录**（canonical 消息在 `chatMessages`） | companion → 浏览器消费者 |
| O | Activity `on/off/_emit` | Activity 运行时 | NO | NO | NO | NO | 注册顺序 | NO | NO | 无 | NO | 同页订阅者；`api.emit` 是**显式 no-op** |
| P | P23 Delivery Runtime（五核 + communication adapter） | P23 | **YES（队列）** | NO（runtime-only；queue 不落库） | YES（落 chatMessages） | 单域（聊天） | `sequenceIndex` 确定性 | 部分（turn end 广播） | NO（失败不自动重发） | `turnId` / `messageId` / `sequenceIndex` | **YES（chatMessages 写入者）** | 生成管线 → 交付队列 → UI |
| Q | P24 Group Runtime（group-runtime-core + communication 群分支） | P24 | 部分（`_groupTurns` runtime map） | 部分（群消息落 chatMessages） | YES | 单域（群聊） | `groupOrder` = `entry.order`；planner 唯一权威 | N/A | NO | `groupTurnId` / `MemberTurn.turnId` / speakerId | chatMessages（与单聊同一 writer 语义） | planner → 成员回合 → UI |
| R | Cinema / `IBMedia` runtime | Cinema App + media adapter | YES（app 内） | 部分（进度写 `activities`） | YES（进度写） | 与 Activity 域协作 | 节流 1.5s（时间序） | N/A | NO | activityId | 经 `IB.activity`（唯一 writer） | 用户操作 → 活动运行时 |
| S | Co-read runtime | Co-read App | YES（app 内） | 部分（页/书签写 `activities`） | YES | 同 R | 翻页序 | N/A | NO | activityId | 经 `IB.activity` | 用户操作 → 活动运行时 |
| T | Browser Runtime | 页面 | YES | 通过 IndexedDB/localStorage | YES | YES | 单线程事件循环 | N/A | N/A | N/A | 各域各自的 canonical store | 全部浏览器域 |
| U | Node companion Runtime（`services/active-message-service.js` + `active/*`） | Active Message companion | YES | **YES（`active-message-service.json`）** | YES（生成/入队） | 跨运行时（HTTP） | 15s tick + 计划状态机 | 事件 ACK 由浏览器消费者完成 | 计划 `maxAttempts` | run/plan/event id | 该 runtime 的 canonical 面是**事件队列**；消息落库仍在浏览器 `chatMessages` | 定时/事件 → 事件队列 → 浏览器 |

其他既有（供 §50 词汇用）：
`services/home-node/mobile-gateway.js` 有**移动端事件频道**（`NOTIFY_EVENTS = ['message.created','message.deleted','cursor.changed','presence.changed','notify.error','ping']`，`broadcastEvent(...)`），
其设计原则明确：**"正文不在事件里 —— 客户端用 sync.changes 取状态"**（事件=通知，状态=拉取）。
这是仓库里**最接近"域事件机制"的既有先例**，但它属于 Home Node / 移动端传输层，不是通用域事件总线。

## 2. CURRENT ARCHITECTURE（只画今天存在的）

```
                         ┌───────────────────────── Browser Runtime（单页面）─────────────────────────┐
   [用户操作] ──UI──▶    │                                                                          │
   [调度器 30s]          │   ┌── INTENT / PLAN ────────────────────────────────────────────────┐   │
   [聊天回合]            │   │  planner（各域自己的 planner / 模型门控）                        │   │
                         │   │   P25-3A orchestration core：Intent→Observe→Plan（只校验 plan）  │   │
                         │   └───────────────┬─────────────────────────────────────────────────┘   │
                         │                   │  Plan（≠ Permission）                               │
                         │   ┌───────────────▼─────────────────────────────────────────────────┐   │
                         │   │  Capability Registry（metadata + binding key，不裁决/不执行）    │   │
                         │   └───────────────┬─────────────────────────────────────────────────┘   │
                         │                   │  Authority route（authorityType）                  │
                         │   ┌───────────────▼─────────────────────────────────────────────────┐   │
                         │   │  Domain Authority（纯裁决：ALLOW / DENY；无状态、无 IO）          │   │
                         │   │   moments(mutation/autonomy) · diary · active-message · role-letter│  │
                         │   └───────────────┬─────────────────────────────────────────────────┘   │
                         │                   │  ALLOW 才执行                                       │
                         │   ┌───────────────▼─────────────────────────────────────────────────┐   │
                         │   │  Domain Executor ──▶ Canonical Writer（每域唯一写点）             │   │
                         │   │   chatMessages / moments / diary_entries / roleLetters /          │   │
                         │   │   roleLetterMemories / activities / active_message_*              │   │
                         │   └───────────────┬─────────────────────────────────────────────────┘   │
                         │                   │  Verify（只读校验 canonical 行）                    │
                         │   ┌───────────────▼─────────────────────────────────────────────────┐   │
                         │   │  Domain Runtime（持状态/生命周期）                                │   │
                         │   │   IB.activity（activities + current 指针 + App 内存）             │   │
                         │   │   Moments / Diary / Letters / Active 域运行时                     │   │
                         │   │   P23 Delivery Runtime（内存队列 queued→delivering→…）           │   │
                         │   │   P24 Group Runtime（groupTurn / MemberTurn / groupOrder）        │   │
                         │   └───────┬───────────────────────┬───────────────────────────────┘   │
                         │           │ CONTROL（调用）        │ DATA（读/写 store）                │
                         │   ┌───────▼───────────┐   ┌───────▼───────────────────────────────┐   │
                         │   │ UI（页面/小窗）    │   │ State Plane（IndexedDB + localStorage）│   │
                         │   └───────────────────┘   └───────────────────────────────────────┘   │
                         │                                                                            │
                         │   EVENT-LIKE FLOW（今天真实存在的三类，均为局部）：                        │
                         │     · LOCAL_CALLBACK：IB.activity.on/off/_emit（api.emit = no-op）         │
                         │     · UI/TRANSPORT：IBApps.broadcast('turn'|'message'|'delta')             │
                         │       仅投给**当前打开的 App**（无 App 打开 ⇒ no-op）；Cinema 按 activityId 过滤│
                         │     · DOM：online / visibilitychange / pointer 事件                        │
                         │                                                                            │
                         │   OBSERVATION FLOW（今天真实存在的两条）：                                 │
                         │     · REQUEST_LOCAL：Cinema 留影帧 → IB.activity.send({visionReference})   │
                         │       → 本轮请求 → sentImages → provider vision（**不落库**）              │
                         │     · PERSISTED：Cinema 进度/字幕、Co-read 页/梗概 → activities.progress   │
                         │       → 下一回合经 getActivityContext 注入 prompt（读回=投影）             │
                         └────────────────────────────────────────────────────────────────────────────┘
                                                   │
                                     TRANSPORT（HTTP 轮询 /events，含 ACK）
                                                   ▼
                         ┌──────────────── Node companion Runtime（独立进程）──────────────────┐
                         │ schedulerTick(15s) → 任务/计划状态机 → generate（模型）→ **事件队列** │
                         │ events / history（持久化 JSON）· 计划状态 · windowsNotify            │
                         │ ⚠ 它不写 chatMessages：消息由浏览器消费者镜像落库（同一 authority）  │
                         └──────────────────────────────────────────────────────────────────────┘
                                                   ▲
                         ┌─── Home Node / Mobile Gateway（另一条传输面）────────────────────────┐
                         │ 事件频道 NOTIFY_EVENTS（message.created / presence.changed / …）     │
                         │ 原则：**事件只通知，状态用 sync.changes 拉取**                        │
                         └──────────────────────────────────────────────────────────────────────┘
```

## 3. Plane Classification（分析标签，不建模块）

| 现有组件 | 实际 plane | 跨 plane 说明 |
| --- | --- | --- |
| 各域 planner / 模型门控 | INTENT PLANE | 部分产出直接进 EXECUTION（legacy 路径） |
| `agent-orchestration-core`（Intent→Observe→Plan） | INTENT PLANE | 只校验 plan，不进 DECISION |
| Capability Registry | INTENT PLANE（能力枚举） | 不裁决、不执行 |
| 四个 domain authority（+ Autonomy Core） | **DECISION PLANE** | 纯裁决；Autonomy Core 另有 DEFER（仅它自己） |
| domain executor / canonical writer | **EXECUTION PLANE** | 写 store ⇒ 也是 STATE PLANE 的入口 |
| IndexedDB / localStorage | **STATE PLANE** | — |
| P23 delivery（五核 + adapter） | **DELIVERY PLANE** | 也是 STATE PLANE（写 chatMessages）；有 runtime 状态（队列） |
| P24 group runtime | **DELIVERY PLANE / RUNTIME PLANE** | 群回合是调度+成员选择，落库仍走 chatMessages |
| `IB.activity` / Moments / Diary / Letters 运行时 | **RUNTIME PLANE** | 各自持有 runtime/指针/投影 |
| Cinema / Co-read / IBMedia | RUNTIME PLANE + UI（FEEDBACK 的现状） | App 内状态 + 进度写回 |
| `IBApps.broadcast` / DOM 事件 / activity 回调 | **EVENT PLANE（仅局部）** | 只覆盖同页面、且不是域事件 |
| Active Message 事件队列（Node + 浏览器消费者） | **EVENT PLANE（单域持久）** + DELIVERY PLANE | 有 ACK/轮询，但语义是"发送结果交付" |
| Mobile Gateway 事件频道 | EVENT PLANE（传输层通知） | 明确"事件不含正文，状态靠 pull" |
| 观察（frame / progress / subtitle / context 文本 / chat context） | **OBSERVATION PLANE（无统一层）** | 分散在请求参数、域字段与投影函数里 |
| 反馈（typing / 语音 UI / 小窗刷新） | **FEEDBACK PLANE（UI 局部）** | 由 `IBApps.broadcast` + App 本地状态实现 |
| 无 | 不存在独立 FEEDBACK / OBSERVATION 模块 | 见 REQUIREMENT MAP |

## 4. P25 Boundary Proof

**P25 解决了的（有测试与守卫证明）**：

| 能力 | 证据 |
| --- | --- |
| Intent | `buildOrchestrationRequest`（request/actor/source/intent，闭集 source，禁 CoT/秘密字段） |
| Capability discovery | `createCapabilityRegistry` + 四个域 adapter 的 `registerXCapabilities`（descriptor 校验、深冻结、禁止凭据/函数） |
| Plan | `validateAgentPlan`（确定性、DAG、无环、有界、禁 CoT/秘密）+ `planStepsInOrder` |
| Permission | 每个 domain authority 的 `decide*`（闭集事实、fail closed、无 default-allow） |
| Execution | executor 注入；side effect 不自动 retry；deny ≠ failed（各域 D/RL/OA 用例） |
| Canonical side effect | 每域**唯一**写点（diary/active-message/role-letter 的单写点守卫；moments 的 canonical writer 收敛） |
| Verification | `verifyDiaryWrite` / `verifyActiveMessageSend` / `verifyRoleLetterWrite`（只读、不补写、不 retry） |

**P25 没解决的（属 P26 gap，不是 P25 bug）**：

Domain Effect 发生**之后**的事：其它 runtime 如何知道（事件）、如何观察（观察层）、
如何形成反馈（反馈回路）、持续 session 谁拥有、资源冲突谁仲裁。
P25 的边界是"**一次动作 → 一个 canonical effect → 一次 verify**"，
它对"跨动作存续的状态"与"只读观察"没有表达位置 —— 这是**范围**问题，不是实现缺陷。

## 5. REQUIREMENT MAP（只画缺口）

```
   ┌─ 已冻结、P26 不得改 ─────────────────────────────────────────────────────────────┐
   │  P23 Delivery（五核）    P24 Group Runtime     P25-3A Foundation + Autonomy Core │
   │  四个 domain authority   Activity runtime      Cinema / Co-read / IBMedia        │
   └─────────────────────────────────────────────────────────────────────────────────┘
                     │  已解决：一次动作 → canonical effect → verify
                     ▼
   ┌─ GAP #1 · Domain Event Mechanism（HARD）────────────────────────────────────────┐
   │  今天：无任何"域事实已发生"的统一表达。                                           │
   │  局部替代：activity 内存回调（emit=no-op）/ IBApps.broadcast（仅当前 App）/       │
   │           Active Message 事件队列（单域、带 ACK）/ Mobile Gateway 通知频道（传输层）│
   │  缺：域拥有的 event identity、producer/consumer 语义、ordering 边界、              │
   │      persistence/replay/ACK 的**按语义分级**要求                                  │
   └─────────────────────────────────────────────────────────────────────────────────┘
   ┌─ GAP #2 · Generic Observation Layer（HARD，条件性范围）─────────────────────────┐
   │  今天：观察散落在 request-local 参数（frame）、域字段（progress/subtitle）、      │
   │       投影函数（activity context / chat context）、UI 状态里。                    │
   │  缺：只读生产者/投影/新鲜度的登记位置（**不经过 authority**）                     │
   └─────────────────────────────────────────────────────────────────────────────────┘
   ┌─ GAP #3 · Session Runtime Contract（HARD）──────────────────────────────────────┐
   │  今天：活动 = 记录 + 指针 + App 内存；`finished` 无写入者；无 lifecycle 迁移。     │
   │  缺：session 身份/生命周期/当前选择的归属与最小状态集合（**状态仍归域运行时**）    │
   └─────────────────────────────────────────────────────────────────────────────────┘
   ┌─ GAP #4 · Resource Arbitration（HARD，当前无冲突 → 仍需契约）───────────────────┐
   │  今天：同角色可并发多活动；无 owner / lease / lock / priority / preemption。      │
   │  缺：冲突判据与仲裁者的归属（不是 authority 的职责，也不是 scheduler 的职责）      │
   └─────────────────────────────────────────────────────────────────────────────────┘
   ┌─ CONDITIONAL ───────────────────────────────────────────────────────────────────┐
   │  #5 Participant / Multi-party Session Contract（今天 1:1；P24 已有 group 参与者）│
   │  #6 Runtime Feedback Contract（今天 UI 局部；无跨域反馈语义）                     │
   │  #7 Domain-scoped Source Vocabulary（若 Activity 纳入 capability 才需要，域内）   │
   └─────────────────────────────────────────────────────────────────────────────────┘
```

## 6. Gap Matrix（§48）

| Gap | Current evidence | Existing owner | Why insufficient | Requirement class | P26 input |
| --- | --- | --- | --- | --- | --- |
| Domain Event Mechanism | 无事件表/无域事件；`IB.activity.emit` 是 no-op；`IBApps.broadcast` 仅当前 App；Active 事件队列属单域 | 无（各家局部替代） | 局部机制没有 event identity / ordering / persistence 语义，且都不表达"域事实" | **HARD_REQUIREMENT**（最小集合） | YES |
| Generic Observation Layer | frame=request-local；progress/subtitle=域字段；context=投影函数 | 各域 / App | 观察无 side effect、不该过 authority，但今天没有登记位置 ⇒ 新观察只能挂 App 本地 | **HARD_REQUIREMENT**（登记与只读契约） | YES |
| Session Runtime Contract | `activities` 只有 `status:'active'`；`finished` 无写入者；指针可重建 | Activity 域运行时 | 运行时只有"记录 + 指针"，没有生命周期语义；跨动作存续的状态无契约 | **HARD_REQUIREMENT** | YES |
| Resource Arbitration | 同角色并发活动（smoke T6）；无 owner/lease/lock/priority/preemption | 无 | 没有仲裁者；authority 无状态、scheduler 只管时间 | **HARD_REQUIREMENT**（契约层） | YES |
| Participant Contract | 活动 1:1 `roleId`；P24 已有群参与者身份 | P24（群）；Activity（1:1） | 两套参与者语义未对齐；多角色活动今天不存在 | CONDITIONAL_REQUIREMENT | YES |
| Runtime Feedback | typing / 小窗刷新靠 `IBApps.broadcast` + App 本地 | App / UI | 反馈不是域 effect，但"谁该被唤醒/通知"没有契约 | CONDITIONAL_REQUIREMENT | YES |
| Source Vocabulary | Activity 真实来源=用户打开/UI 定时器；现有闭集无法表达 | 各域自持 | 全局扩张被禁止（3E verdict）；只在域内版本化 | CONDITIONAL_REQUIREMENT | YES |
| Cross-runtime Transport | companion 事件队列（HTTP 轮询 + ACK）；Mobile Gateway 通知频道 | Active Message / Home Node | 今天只有"单域"跨运行时通道，没有通用语义 | FUTURE_REQUIREMENT | YES |
| Event Persistence | Active 事件持久；activity 回调/broadcast 不持久；frame 不落库 | 各域 | "全部落库"与"全部不落库"都不成立 | FUTURE_REQUIREMENT（按语义分级） | YES |
| Event Replay | 浏览器可从 canonical state 重建（指针可重建、消息可读回）；companion 依赖自身 JSON | 各域 | replay 需求未被证明 | FUTURE_REQUIREMENT | YES |
| Event ACK | 只有 Active companion 事件有 ACK | Active Message | 其它域没有 ack 需求证据 | NOT_REQUIRED（除既有） | NO |
| Event Ordering | P23 用 `sequenceIndex`；P24 用 `groupOrder`；其它域无全局序 | P23 / P24 | 全局序无证据；per-domain/per-entity 已够 | Future（按域） | YES |

## 7. Boundary Matrix（§49）

| Concern | Capability | Authority | Executor | Writer | Runtime | Observation | Event | Feedback |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Moment create | YES（`moment.post`） | YES（Autonomy） | YES | YES（moments canonical writer） | YES（Moments runtime） | NO | NO（无域事件） | UI |
| Diary write | YES（`diary.write`） | YES（Diary Authority） | YES | YES（`_diaryWriteCanonical`） | YES（Diary runtime） | NO | NO | UI |
| Active message send | YES（`active_message.send`） | YES（Active Message Authority，浏览器+Node 共用） | YES | YES（浏览器 `_activeWriteCanonical`；Node 写事件队列） | YES（两运行时） | NO（delivery 记录不是观察） | 部分（Active 事件队列=单域交付事件） | UI（typing/notification） |
| Role letter write | YES（`role_letter.write`） | YES（Role Letter Authority） | YES | YES（`_rlWriteCanonical`） | YES（Role Letter runtime） | NO | NO | 页内 toast |
| Activity create | **NO（未登记）** | **NO** | 域内函数 | YES（`activities`） | YES（`IB.activity`） | NO | NO | UI 打开 |
| Activity progress | **NO** | NO | 域内函数 | YES（`activities.progress`） | YES | **YES（PERSISTED_OBSERVATION）** | NO | UI 进度条 |
| Cinema frame | NO | NO（不该过 authority） | NO | **NO（request-local，不落库）** | App 本地 | **YES（REQUEST_LOCAL_OBSERVATION）** | NO | provider（本轮 vision 输入） |
| Current activity pointer | NO | NO（自述"不是 authority"） | NO | 指针写 localStorage | YES | NO | NO | UI 选择 |
| Session ownership | **NO_CURRENT_HOME** | NO | NO | NO（无 owner 字段） | 部分（指针=事实所有权） | NO | NO | NO |
| Domain event | NO | NO | NO | NO | 内存回调（no-op emit） | 无 | **NO_CURRENT_HOME** | NO |
| Runtime feedback | NO | NO | NO | NO | App 本地状态 | NO | 部分（`IBApps.broadcast` = UI/TRANSPORT） | **局部存在，无契约** |

## 8. Vocabulary Matrix（§50）

| 术语 | IB-specific 定义 | 当前例子 | 非例子 |
| --- | --- | --- | --- |
| EVENT | "**发生了什么**"的域事实表述；有生产者语义与（可选）持久/顺序要求 | Active Message 的 `sent`/`skipped`/`failed` 事件（`events[]` + ACK）；Mobile Gateway 的 `message.created`（传输层通知） | `IBApps.broadcast('turn')` 的 UI 广播；`IB.activity` 的 `_emit`（内存回调）；typing 提示 |
| OBSERVATION | "**现在是什么**"的只读读取/投影；无 side effect、默认不经 authority | Cinema 留影帧（request-local）；Cinema 进度/字幕、Co-read 页（`activities.progress`）；activity context / chat context 文本 | 任何 canonical 写；任何 authority decision |
| STATE | 域数据中可长期存续、可被读回的事实 | `activities`、`moments`、`diary_entries`、`roleLetters`、`chatMessages` | 内存队列、指针、投影 |
| POINTER | 可重建的"当前选择"线索，**不是** canonical state、不是 authority | `ib_activity_current_v1`（每角色一个） | `activities.status`（域状态）；`activeThreadId`（UI 选择） |
| PROJECTION | 由 state/pointer 派生的只读视图 | `resolveActivity` 的返回值；`getActivityContext` 的 prompt 文本 | 持久化记录；事件 |
| COMMAND | 请求域执行一次动作的意图（经 candidate → authority） | `diary.write` / `active_message.send` / `role_letter.write` / `moment.post` 的 candidate | 观察读取；`IB.activity.openChat`（UI 导航） |
| AUTHORITY DECISION | 纯裁决结论（ALLOW / DENY；Autonomy Core 另有 DEFER 但仅其自身） | 四个域 authority 的 `decide*` | runtime lifecycle 迁移（如 pause）；调度排队 |
| EXECUTION | 按已授权意图执行、产生 canonical effect 的唯一动作 | `_diaryWriteCanonical` 的调用；Active/Role Letter executor；P23 delivery 的落库 | verify（只读）；观察 |
| DELIVERY | 把一个**已经产生**的消息/单元按时间与顺序交付给会话流 | P23 delivery-runtime（队列 + typing + cancel）；Active companion 的事件投递 | 域事件（不是消息投递）；观察 |
| FEEDBACK | 把已发生的 effect/状态变化回传给消费者（UI/规划器）的通道（今天只有 UI 局部） | `IBApps.broadcast('turn'|'message')` 驱动小窗/typing | 域事件机制（不存在）；canonical 写 |
| SESSION | 跨多次动作存续、有身份与生命周期的运行单元（今天只有 Activity 的"记录+指针"近似） | `activities` 记录 + current 指针（**近似，不是完整 session**） | 单次命令（diary.write）；pointer 本身；投影 |
| RESOURCE OWNERSHIP | 对某个稀缺资源（活动/会话/播放器）的归属或独占声明（**今天不存在**） | 无（`findActivity` 只做同资源复用） | 指针（选择≠所有权）；domain lock（不存在） |
