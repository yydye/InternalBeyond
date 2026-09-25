# P26-6 · Feedback Consumption & Wake Eligibility Contract

状态：**FOUNDATION / CONTRACT / PURE CORE / AUDIT-FIRST / NO PRODUCTION INTEGRATION**。
建立 `assets/js/feedback-consumption-core.js`（`IBFeedbackConsumptionCore`）。
**Production consumers = 0 · Production wakes = 0**：Active Message / Diary / Role Letter /
Moments / Activity / Cinema / Voice / P24 Group Runtime / Middle Brain / Agent Runtime
全部零接线、零改动；**没有** Event Bus / Feedback Bus / Wake Router / Wake Queue /
Scheduler / Policy Engine / Feedstore / Wake History / Attention Queue。

---

## 1. Why Consumption exists

P26-5 冻结了 **Feedback = "已有事实/观察是否值得进一步注意"** 这一层信号，但**故意**不回答
「注意之后呢」。若没有这一层，"值得注意"会立刻被解读成"去唤醒 agent / 去执行"——
于是 Feedback 会偷偷变成第二套 Autonomy。

Consumption 存在的唯一目的，是在 **Feedback** 与 **未来 Runtime Wake** 之间插入一个
**纯、确定、非执行、非路由、非持久** 的评估面：把"值得注意"降级为一个受控的
**注意力处置结论**（disposition），而不是动作。它回答的是——

> 一条 Feedback 被消费后，系统可以得出什么**注意力处理结论**？

并明确：**Eligibility（资格）不是 Execution（执行）**。

## 2. Definition

> **Feedback Consumption = a pure evaluation of a Feedback signal against explicit context
> to determine its attention disposition.**

不是 handling side effect · 不是 execution · 不是 notification · 不是 model call ·
不是 routing · 不是 scheduling · 不是 persistence。它只做一个**无副作用**的判定，
并把判定理由写成**机器可读原因码**。

```
evaluateFeedbackConsumption(feedback, context) ──▶ { disposition, reason, feedbackId, … }
```

## 3. Feedback vs Consumption

| 关注点 | P26-5 Feedback | P26-6 Consumption |
| --- | --- | --- |
| 回答什么 | 是否值得进一步注意 | 注意力的**处置结论**是什么 |
| 形态 | 一条**信号**（feedbackId/domain/source/reason/timestamp…） | 一个**评估结果**（disposition/reason/feedbackId…） |
| 修改输入？ | —（本身是 frozen signal） | **否**，只读，输出独立 result 对象 |
| 副作用 | 无 | **无** |
| 是否执行 | 否 | **否** |
| 时钟/随机 | 无 | **无** |

Consumption **消费** Feedback，但**从不改写**它；Feedback 仍是 P26-5 冻结的不可变信号
（守卫 C30 证明评估前后 feedback 逐字节不变）。

## 4. Attention Disposition（最小闭集）

处置是**闭集**，只有三个（守卫 C5）：

```
IGNORE  |  OBSERVE  |  WAKE_ELIGIBLE
```

| 处置 | 语义 |
| --- | --- |
| **IGNORE** | 此 feedback 不需要进一步 runtime attention |
| **OBSERVE** | feedback 有意义，但只供状态 / telemetry / UI / future context 使用 |
| **WAKE_ELIGIBLE** | feedback **有资格**进入未来 wake request policy |

**明确禁止**加入 `EXECUTE` / `ACTION` / `ALLOW` / `DENY` / `RUN` / `SEND` / `POST` / `DEFER`
（守卫 C5 断言这些词不出现在处置闭集里）。

## 5. IGNORE

`IGNORE` = 该信号**不值得**进一步 runtime attention。当前由三类事实触发：

- `cancelled === true` → `reason: 'cancelled'`（P25-3A / delivery / plan 的既有取消语义）
- `alreadyConsumed === true` → `reason: 'duplicate'`（caller 持有的 dedupe 事实）
- `recentEquivalent === true` → `reason: 'duplicate'`（caller 持有的近邻等价事实）

`IGNORE` **不是**删除：它只是处置结论，不产生任何副作用、不落库、不入队。

## 6. OBSERVE

`OBSERVE` = 信号有意义，但**只供**状态 / telemetry / UI / future context 使用。
当前由两类触发：

- 默认（`wakeCapable !== true`）→ `reason: 'default-observe'`
- `cooldownActive === true` → `reason: 'cooldown'`（信号仍成立，只是现在不该唤醒）

**`OBSERVE ≠ UI notification`**（见 §21）：它不调用 toast / Notification / push。

## 7. WAKE_ELIGIBLE

`WAKE_ELIGIBLE` = feedback **有资格**进入未来 wake request policy，`reason: 'wake-eligible'`。
它**只**在 caller 显式传入 `wakeCapable === true` 时成立——即"该信号的原因类别，
按**显式消费策略**是否可唤醒"这一**策略结论由 caller 提供**，而不是由 Core 从 severity /
priority 猜出来。

判定顺序是**确定性**的（早期阶段先赢）：

```
1) feedback 非法        → ok:false / 'invalid-feedback'（无 disposition）
2) context 非法         → ok:false / 'invalid-context'（无 disposition）
3) cancelled            → IGNORE / 'cancelled'
4) alreadyConsumed      → IGNORE / 'duplicate'
5) recentEquivalent     → IGNORE / 'duplicate'
6) cooldownActive       → OBSERVE / 'cooldown'
7) wakeCapable !== true → OBSERVE / 'default-observe'
8) 否则                 → WAKE_ELIGIBLE / 'wake-eligible'
```

**severity / priority 完全不参与**（守卫 C9）。

## 8. Wake Eligibility != Wake

```
WAKE_ELIGIBLE  ≠  WAKE_REQUESTED  ≠  AGENT_WOKEN
```

`WAKE_ELIGIBLE` 是 **policy 结论（资格）**；`Wake Request` 是 **未来 runtime command**；
`Agent Wake` 是 **未来 runtime effect**。三者**不得压缩**。本阶段只到 `WAKE_ELIGIBLE`：
不创建 WakeRequest runtime、不产生 wake、不唤醒 agent（守卫 C16）。

## 9. Wake != Action

```
AGENT_WOKEN  ≠  ACTION_CREATED  ≠  ACTION_ALLOWED  ≠  ACTION_EXECUTED
```

即使未来真的唤醒 agent，那也只是"开始思考"，**不等于**创建 Action，更不等于 Action
被授权（ALLOW）或被真正执行。这些层全部在 P25 Autonomy 之下，本契约不触及。

## 10. Action != Allow

Action 的**创建**（planner 产出意图）与 Action 的**授权**（Authority 判定 ALLOW/DENY）
是两件不同的事，授权与**执行**（Executor）又是第三件事。Consumption 不下沉到任何一层：
输出里**没有** action / capability / permission / allow / deny / execute 字段（守卫 C10/C12/C13）。

## 11. P25 Autonomy Boundary

**P26-6 不能成为第二套 Autonomy Core。** P25 继续**独占**：

```
Action ──▶ Autonomy ──▶ Domain Authority ──▶ Executor
```

P26-6 只回答「这个 Feedback 是否值得未来 runtime 进一步处理？」，**不得**回答
「应该执行什么动作？」。它**不**调用 P25 Autonomy、Moment/Diary/Active-Message/Role-Letter
Authority，也**不**跳过 P25（守卫 C12/C14）。

## 12. Severity Boundary

P26-5 已冻结：`severity ∈ low·medium·high` 是 **Feedback 自身属性**。

**`severity === 'high'` ≠ 自动 `WAKE_ELIGIBLE`**：必须通过**显式** consumption policy
（即 caller 注入的 `wakeCapable`）才能进入资格。守卫 C9 明确断言：仅有 high severity、
无 `wakeCapable` 时结果为 `OBSERVE`（`default-observe`）；Core 源码里 severity 甚至**不出现**
在判定路径上。

## 13. Priority Boundary

P26-5 已冻结：`priority` / `urgency` / `rank` / `schedule` / `deadline` / `retry` 属 **policy 层**。
本阶段的结论：**消费契约不需要 priority**（答案 NO）。

理由：`WAKE_ELIGIBLE` 只是**资格**，不是**排序**。跨信号排序需要全局视野与时间压力，
属未来 scheduler / policy；把它塞进消费契约只会制造第二套调度权威。
因此 `priority` 等被列入 `FORBIDDEN_CONTEXT_FIELDS`，成为**可测试的拒绝边界**（守卫 C32）。

## 14. Deduplication Boundary

消费**需要**"重复"这一事实，但**不拥有** dedupe store。

- P26-5 的 `feedbackId` 本身可作为 dedupe key（确定性派生）。
- Core **允许** caller 注入 `alreadyConsumed` / `recentEquivalent` 两个布尔事实。
- Core **不持久化、不记录已消费集合**（禁止 consumed store / wake history / attention history）。

语义：`alreadyConsumed === true` 或 `recentEquivalent === true` ⇒ `IGNORE / 'duplicate'`。
同一条 feedback 重复消费**不会**升级成 wake（守卫 LM1/LM2）。

## 15. Cooldown Boundary

消费**需要**冷却事实，但**不持有时钟状态**。

- Core **允许** caller 注入 `cooldownActive`（现有冷却事实：Active nudge 8 分钟 / plan
  minInterval / 角色对 24~72h 冷却 / 12h 顺延）。
- Core **禁止**：`setTimeout` / `setInterval` / scheduler / `lastWake` store / 时钟读取。
- `cooldownActive === true` ⇒ `OBSERVE / 'cooldown'`（信号仍成立，只是**现在**不该唤醒）。

## 16. Runtime Availability Boundary

**eligibility ≠ deliverability**。判断"是否值得 wake"与"现在能不能 dispatch"是两件事：

- runtime offline / transport 不可用属于 **deliverability**，不是资格问题。
- 因此本契约**不**把 `runtimeAvailable` 纳入输入（列入 `FORBIDDEN_CONTEXT_FIELDS`）；
  一条本身值得 wake 的信号，即使 runtime 当前 offline，其**资格结论不变**。

把传输/运行时可用性错误塞进 eligibility 会把"注意力判定"污染成"投递判定"。

## 17. Event Boundary

P26-6 **不订阅 Event**，输入是 **Feedback**（不是 raw Domain Event）。未来若 Event 要进入
consumption，必须先经 **P26-5 Feedback producer**：

```
Event ──▶ Feedback producer ──▶ Feedback ──▶ Consumption
```

**禁止** `Event ──▶ Wake Eligibility`（绕过 P26-5）。守卫 C18 证明 Core 内零
`subscribe` / `emit` / `listener` / `dispatch` / `router` / `domain-event-core` 依赖。

## 18. Observation Boundary

同理：

```
Observation ──▶ Feedback producer ──▶ Feedback ──▶ Consumption
```

**禁止** `Observation ──▶ Wake`。Consumption 不读取 observation 帧/进度等（守卫 C19）。

## 19. Session Boundary

未来 Session 状态可成为 **consumption context** 的一个事实来源，但 Consumption
**不拥有** Session：不得 `start/end/transition` session，不依赖 `session-core`（守卫 C20）。
若将来需要 `sessionActive`，应由 caller 作为**注入事实**提供，而非 Core 自持。

## 20. Resource Boundary

Resource 冲突未来可**产生 Feedback**，但 Consumption **不做 resource arbitration**：
不 grant / 不判 conflict / 不 deny / 不 lease / 不 lock（守卫 C21）。

## 21. Notification Boundary

`OBSERVE ≠ UI notification`，`WAKE_ELIGIBLE ≠ Notification`。Core 不调用
toast / Notification API / push（守卫 C17）。

## 22. Persistence Boundary

Core **不持久化**：禁止 consumed feedback store / wake history / wake queue / attention history。
既有 DB（`DB_VER`/store 列表）逐字节未变（守卫 G2）。若未来确需，另阶段设计。

## 23. Queue Boundary

禁止 wake queue / feedback queue / attention queue。`WAKE_ELIGIBLE` **只是一个结果**，
不是入队动作（守卫 C23）。

## 24. Scheduler Boundary

禁止 scheduler / timer / retry / backoff（守卫 C24）。注意与既有调度器的区别见附录 C：
**scheduler due ≠ wake eligibility**。

## 25. Loop Prevention Requirements

未来 wake-capable 链路的隐患：

```
Feedback A ─▶ WAKE_ELIGIBLE ─▶ Agent ─▶ Action ─▶ Domain Effect ─▶ Event ─▶ Feedback B ─▶ …
```

本阶段**不实现**链路、不实现**全局 loop detector**。但**冻结**未来 wake-capable path
**必须支持 causation**：

| 机制 | 归属阶段 | 级别 |
| --- | --- | --- |
| `causationId`（P26-1 已有） | Domain Event | **MUST** |
| `derivedFrom`（P26-5 已有） | Feedback | **MUST** |
| `feedbackId` 作为 dedupe key | Consumption / caller | **MUST** |
| `correlationId`（跨 wake request→action→event 关联） | 未来 Wake Runtime | **SHOULD** |
| `origin`（信号来源标记） | 未来 Wake Runtime | **SHOULD** |
| `depth`（因果深度上限） | 未来 Wake Runtime / policy | **FUTURE** |
| `dedupe` 持久化 | 未来 store | **FUTURE** |
| `cooldown` 持久化 | 未来 policy | **FUTURE** |

即：关联 `feedback → wake request → action → event` 的**要求**在此冻结，
但**完整 runtime schema 不在本阶段设计**。

## 26. Pure Core API

刻意保持极小（守卫 G3 断言导出函数恰为三个）：

```js
evaluateFeedbackConsumption(feedback, context) // 唯一入口：纯评估
validateConsumptionContext(context)            // 校验闭集布尔 context
describeConsumption(result)                    // 无正文诊断摘要
```

常量：`CONSUMPTION_VERSION` / `DISPOSITIONS` / `REASONS` / `CONTEXT_FIELDS` /
`FORBIDDEN_CONTEXT_FIELDS` / `ALLOWED_RESULT_FIELDS` / `CONSUMPTION_ERRORS`。

**禁止**：`FeedbackConsumerManager` / `WakeManager` / `AttentionScheduler` / `PolicyEngine`
等类与名字。Feedback 校验**委托** P26-5（唯一实现），不复制第二份校验器。

确定性（§36）：同 `Feedback + Context` ⇒ 同结果；禁止 `Date.now` / `Math.random` /
隐藏状态 / 全局单例（守卫 C26/C27）。结果 JSON-serializable、深冻结（守卫 C28）。

## 27. Examples

以下只是 **contract examples**，**不生产接线**：

| Case | 输入 | 期望 |
| --- | --- | --- |
| **A** | feedback `camera-unavailable`，severity `medium`，context `{}` | `OBSERVE`（`default-observe`） |
| **B** | feedback `call-stalled`，severity `high`，context `{}` | **不得**仅因 high 自动 `WAKE_ELIGIBLE` ⇒ `OBSERVE` |
| **C** | feedback `user-request-needs-attention` + **显式策略** context `{ wakeCapable: true }` | `WAKE_ELIGIBLE`（`wake-eligible`） |
| **D** | 重复 feedback，context `{ alreadyConsumed: true }` | `IGNORE`（`duplicate`） |

## 28. Non-goals

本阶段**不做**：Event Bus · Feedback Bus · Wake Router · Agent Router · Wake Request Runtime ·
Wake Runtime · Agent Wake · Scheduler · Policy Engine · Purpose/Tool 选择 · Action 创建 ·
Capability 选择 · Model/Provider 调用 · Notification · 持久化 · Queue · 生产 consumer 接线。

---

## 附录 A · Wake Ladder（冻结）

```
Feedback Exists
      │
      ▼
Feedback Consumption          ← P26-6 起点（本契约）
      │
      ▼
WAKE_ELIGIBLE                 ← P26-6 终点（只到这一层）
      │
      ▼
[future Wake Request]
      │
      ▼
[future Runtime Wake]
      │
      ▼
[future Planner]
      │
      ▼
Action
      │
      ▼
P25 Autonomy
      │
      ▼
Domain Authority
      │
      ▼
Executor
```

**P26-6 只到 `WAKE_ELIGIBLE`。** 方括号内全部是未来阶段。

## 附录 B · Boundary Matrix

| Concern | Consumption Core owns? |
| --- | --- |
| feedback validation | **delegated**（P26-5 是唯一实现） |
| attention disposition | **YES** |
| reason | **YES** |
| severity definition | **NO** — P26-5 |
| priority | **NO** |
| urgency | **NO** |
| wake eligibility | **YES** |
| wake execution | **NO** |
| action creation | **NO** |
| capability selection | **NO** |
| permission | **NO** |
| execution | **NO** |
| persistence | **NO** |
| queue | **NO** |
| scheduler | **NO** |
| routing | **NO** |
| notification | **NO** |

## 附录 C · Existing Autonomy & Scheduler Comparison

P25 Autonomy Decision vs P26 Feedback Consumption：

| Concern | P25 Autonomy | P26 Consumption |
| --- | --- | --- |
| input | Action | Feedback |
| output | ALLOW / DENY / DEFER | IGNORE / OBSERVE / WAKE_ELIGIBLE |
| permission | YES | **NO** |
| execution gate | YES | **NO** |
| agent wake | NO | NO |
| capability | downstream | none |
| state | runtime facts | explicit context |

**无重复**：P25 判"这个 Action 能不能执行"，P26-6 判"这个 Feedback 值不值得未来注意"；
输入、输出、权限语义都不同，因此**不**创建第二套 Autonomy（守卫 C14 断言无 Autonomy 依赖）。

既有调度器 vs Wake Eligibility（**scheduler due ≠ wake eligibility**）：

| 机制 | 位置 | 触发后做什么 | 是否 = wake eligibility |
| --- | --- | --- | --- |
| Active Message scheduler | `active/scheduler.js` 每 15s `schedulerTick` | 到点 → 走 Authority → 发送 | **NO**（due 只是调度事实） |
| Diary tick | `active-diary/diary.js` `_diaryTick` | 到点 → 生成日记（fail-open） | **NO** |
| Role Letter tick | `role-letters.js` `_roleLettersTick` | 每角色 1 封/天 + 对偶冷却 + 模型门控 | **NO** |
| Activity nudge | `activity/activity-runtime.js` `nudge` | 8 分钟冷却 → 生成主动计划 | **NO** |

它们都是**既有调度/域反应**，本阶段**不重构**：`due` 是时间事实，`WAKE_ELIGIBLE`
是注意力资格，二者不可互换。

## 附录 D · Final Answers（Q1–Q23）

1. **Feedback Consumption 是什么？** 对一条 Feedback 信号对照显式 context 做**纯评估**，
   得出注意力处置结论。
2. **与 Feedback 的区别？** Feedback 是**信号**（是否值得注意）；Consumption 是**评估结果**
   （处置 + 原因码），且**从不改写** Feedback。
3. **Disposition 闭集？** `IGNORE` / `OBSERVE` / `WAKE_ELIGIBLE`。
4. **WAKE_ELIGIBLE 是什么？** 一条反馈**有资格**进入未来 wake request policy 的 policy 结论。
5. **WAKE_ELIGIBLE 是否等于 Wake？** **否**（≠ 请求 ≠ 真正唤醒）。
6. **Wake 是否等于 Action？** **否**。
7. **Action 是否等于 ALLOW？** **否**（创建 ≠ 授权 ≠ 执行）。
8. **severity high 是否自动 wake eligible？** **否**——必须经显式策略（`wakeCapable`）。
9. **priority 是否进入本契约？** **否**（属 policy，被列入禁用字段）。
10. **DEFER 是否需要？** **否**——"以后可能 wake"属未来 scheduler / cooldown / wake runtime，
    当前代码事实不要求，故**不引入**。
11. **duplicate 如何处理？** caller 注入 `alreadyConsumed`/`recentEquivalent` ⇒ `IGNORE/duplicate`；
    Core 不持有 dedupe store。
12. **cooldown 属于哪里？** caller 注入的**事实**（`cooldownActive`）⇒ `OBSERVE/cooldown`；
    时钟不在 Core。
13. **runtime unavailable 是否改变 eligibility？** **否**（属 deliverability，不入输入）。
14. **是否调用 P25 Autonomy？** **否**。
15. **是否选择 Capability？** **否**。
16. **是否调用模型？** **否**（纯 / 确定）。
17. **是否持久化？** **否**。
18. **是否排队？** **否**。
19. **是否调度？** **否**。
20. **是否接入生产 consumer？** **否**（Production consumers = 0）。
21. **是否执行真实 Agent Wake？** **否**（Production wakes = 0）。
22. **Event Bus 是否因此成为必要？** **否**——输入是 Feedback，不是 Event。
23. **下一阶段真正缺的是什么？** 一个把 `WAKE_ELIGIBLE` 转成 **Wake Request** 的未来 runtime
    （含 causation / dedupe / cooldown 的**注入式**策略），以及消费结论的**生产消费者**——
    都不在本阶段。
