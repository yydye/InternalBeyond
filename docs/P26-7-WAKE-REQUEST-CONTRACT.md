# P26-7 · Wake Request Contract

状态：**FOUNDATION / CONTRACT / PURE CORE / AUDIT-FIRST / NO PRODUCTION INTEGRATION**。
建立 `assets/js/wake-request-core.js`（`IBWakeRequestCore`）。
**Production wake request = 0**：Active Message / Diary / Role Letter / Activity / Cinema /
Voice / Middle Brain / P24 Group Runtime 全部零接线、零改动；**没有** Wake Runtime /
Wake Queue / Scheduler / Event Bus / Policy Engine / 请求存储 / Agent Wake。

---

## 1. Definition

> **Wake Request = a request object representing that a previously eligible signal asks a
> future runtime to consider activation.**

不是 Wake · 不是 Agent execution · 不是 Action · 不是 Capability call · 不是 Permission。
它只是**一个请求对象**：把"已经 eligibility 的信号"翻译成"请未来的 runtime 考虑一次激活"。

## 2. Boundary Ladder

```
Feedback Exists
      │
      ▼
Feedback Consumption
      │
      ▼
WAKE_ELIGIBLE
      │
      ▼
Wake Request          ← 本阶段（终点）
      │
     STOP

（之后，未来阶段：）
Wake Runtime ─▶ Planner ─▶ Action ─▶ P25 Autonomy ─▶ Domain Authority ─▶ Executor
```

**P26-7 只到 Wake Request。** STOP 之下的一切都不实现。

## 3. Wake Eligibility Relationship

**`WAKE_ELIGIBLE != Wake Request`**：

| | WAKE_ELIGIBLE（P26-6） | Wake Request（P26-7） |
| --- | --- | --- |
| 是什么 | 一个**判断结果**（policy 结论） | 一个**新的请求对象** |
| 身份 | feedbackId + disposition | wakeRequestId（新身份） |
| 谁产出 | Feedback Consumption | createWakeRequest（**仅从** eligible 消费结果） |

**允许** `WAKE_ELIGIBLE → createWakeRequest`；**禁止** `Feedback → Wake Request`——
不得绕过 Consumption。实现上 `createWakeRequest(consumption, feedback, options)` 要求：

- `consumption.ok === true` 且 `consumption.disposition === 'WAKE_ELIGIBLE'`（否则 `not-eligible`）；
- `feedback.feedbackId === consumption.feedbackId`（否则 `feedback-mismatch`）。

把裸 Feedback 当作第一参数传入 ⇒ `not-eligible`（守卫 W2）。

## 4. Producer Boundary

唯一合法生产者是 **Feedback Consumption**（`createdFrom: 'consumption'`）。
**禁止**：Event producer · Observation producer · Capability · Authority · Executor 创建 Wake Request。

## 5. Identity Contract

最小身份（闭集字段）：

```
{
  wakeRequestId,   // REQUIRED  稳定身份（注入优先，否则确定性派生 'wr_<token>'）
  feedbackId,      // REQUIRED  来自 eligible 消费结果的信号身份
  domain,          // REQUIRED  信号所在域（token），随 feedback 携带
  source,          // REQUIRED  信号来源（点分标识，如 cinema.runtime），随 feedback 携带
  reason,          // REQUIRED  机器可读原因码（token），随 feedback 携带
  createdFrom,     // REQUIRED  生产者步骤（默认 'consumption'）
  derivedFrom?,    // OPTIONAL  因果指针（随 feedback 携带）
  causationId?,    // OPTIONAL  因果指针（caller 注入）
  version          // 固定 'wake-request/v1'
}
```

**wakeRequestId 如何生成？** 确定性：`'wr_' + stableToken(feedbackId|domain|source|reason|createdFrom|derivedFrom|causationId)`；
注入 `options.wakeRequestId` 时优先。
**是否 deterministic？** 是——同输入同 id。
**是否需要 correlationId？** 本阶段**不加**（P26-6 已把它列为 SHOULD/FUTURE）；跨 wake request→action→event
的关联留给未来 Wake Runtime。

**禁止**：random UUID · hidden timestamp · 任何未注入的时间/随机来源。

## 6. Causation Chain

```
Event ─▶ Feedback ─▶ Consumption ─▶ Wake Request
```

请求**保留**因果指针：`feedbackId`（必带）、`derivedFrom`（随 feedback）、`causationId`（caller 注入）。
本阶段**不**设计完整 runtime trace，也不做因果深度/去重的持久化。

## 7. Request State

**不引入 state。** 候选 `created / consumed / expired` 属于未来的**队列生命周期**，
本阶段不做请求队列，因此 Wake Request 就是**一个纯对象**——无状态机、无生命周期字段。

## 8. Duplicate Boundary

两个相同 Feedback **不会**由 Core 去重：Core **不持有 store**。
允许 caller 提供事实 `alreadyRequested`：为 `true` 时 `createWakeRequest` 返回
`{ ok:false, errors:['already-requested'] }`。**禁止** WakeRequestStore / 去重集合。

## 9. Cooldown Boundary

Wake Request Core **不拥有** timer / clock / cooldown state。若未来需要冷却，
由 caller 决定**是否调用** create（或提供显式 context）——Core 侧保持无状态、无时钟。

## 10. Priority Boundary

**禁止** `priority` / `rank` / `urgency` / `deadline`（P26-5 已冻结为 policy 层）。
Wake Request 是**请求**，不是**调度**：把它塞进请求只会制造第二套调度权威。
这些字段被列为 `POLICY_ONLY_FIELDS`，扫描时显式 `policy-only-field` 拒绝（守卫 W17）。

## 11. Queue Boundary

**禁止** queue / pendingRequests / waitingList。Wake Request **只是对象**，不入队（守卫 W7）。

## 12. Scheduler Boundary

**禁止** timer / retry / backoff / expiration worker（守卫 W8、W18）。没有任何时间驱动逻辑。

## 13. Runtime Boundary

Wake Request **不能**：启动 Agent · 调用模型 · 调用 Planner · 调用 Autonomy · 调用 Authority
（守卫 W9–W14）。它只被创建、被校验、被描述。

## 14. P25 Autonomy Boundary

未来链路 `Wake Request → Runtime → Planner → Action` **之后**才进入 P25 Autonomy。
本阶段**零 P25 dependency**：不 require autonomy-core，不出现 autonomy/Autonomy 语义（守卫 W12）。

## 15. Authority Boundary

不调用任何域权威（Moment / Diary / Active Message / Role Letter），不做 permission decision（守卫 W13）。
`WAKE_REQUESTED != ACTION_ALLOWED`。

## 16. Executor Boundary

不创建 action、不调 executor（守卫 W14）。`ACTION_CREATED != ACTION_ALLOWED != ACTION_EXECUTED`。

## 17. Persistence Boundary

**禁止** wake_request_store / history / database / localStorage（守卫 W15）。
`DB_VER` 与 store 列表逐字节未变（守卫 G2）。

## 18. Event Bus Boundary

**禁止** publish / subscribe / emit / consume。Wake Request **不进入 Event Bus**（守卫 W16）。

## 19. Pure API

刻意的极小面（守卫 G3 断言导出函数恰为三个）：

```js
createWakeRequest(consumption, feedback, options) // 唯一入口：从 eligible 消费结果创建
validateWakeRequest(request)                      // shape / 闭集 / 语法校验
describeWakeRequest(request)                      // 无正文诊断摘要
```

常量：`WAKE_REQUEST_VERSION` / `ELIGIBLE_DISPOSITION` / `DISPOSITIONS`（**来自** P26-6，不复制）/
`ALLOWED_FIELDS` / `REQUIRED_FIELDS` / `OPTIONAL_FIELDS` / `OPTION_FIELDS` /
`POLICY_ONLY_FIELDS` / `RESERVED_BODY_FIELDS` / `WAKE_REQUEST_ERRORS`。

**禁止**：`WakeManager` / `WakeService` / `WakeQueue` / `PolicyEngine`。
Feedback 校验**委托** P26-5；处置词汇**来自** P26-6（守卫 W21 证明同一引用）。
确定性：同输入同结果；无时钟/随机/隐藏状态（守卫 W5/W6/W20）。

## 20. Boundary Matrix

| Concern | Wake Request Core owns? |
| --- | --- |
| wake request identity | **YES** |
| causation pointers (feedbackId/derivedFrom/causationId) | **YES**（携带） |
| wake eligibility | **NO** — P26-6 |
| request queue | **NO** |
| request state machine | **NO** |
| request store / history | **NO** |
| scheduler / timer | **NO** |
| runtime activation | **NO** |
| action creation | **NO** |
| capability selection | **NO** |
| permission | **NO** |
| execution | **NO** |
| priority / urgency | **NO**（policy） |
| persistence | **NO** |
| event bus | **NO** |

## 21. Examples

仅 contract examples，**不生产接线**：

| Case | 输入 | 期望 |
| --- | --- | --- |
| **A** | eligible 消费结果 + 匹配 feedback | `ok:true`，`wakeRequestId` 前缀 `wr_`，`createdFrom:'consumption'` |
| **B** | OBSERVE/IGNORE 消费结果 | `not-eligible` |
| **C** | 裸 feedback（未经 Consumption） | `not-eligible`（不得绕过） |
| **D** | feedback 与 consumption 身份不一致 | `feedback-mismatch` |
| **E** | `options.alreadyRequested === true` | `already-requested` |

## 22. Non-goals

不做：Wake Runtime · Wake Queue · Agent Wake · Event Bus · Scheduler · Policy Engine ·
Capability Selection · Action Creation · Production Consumer · 任何持久化 / 时钟 / 随机。

---

## 附录 · Final Answers（Q1–Q10）

1. **Wake Request 是什么？** 一个请求对象，表示"一条已 eligibility 的信号请求未来 runtime 考虑激活"。
2. **与 WAKE_ELIGIBLE 区别？** Eligibility 是**判断结果**；Request 是**新的请求对象**（新身份 `wakeRequestId`）。
3. **与 Agent Wake 区别？** 请求 ≠ 激活：Wake Request 不启动任何 agent。
4. **谁创建？** 只能由 **Feedback Consumption**（从 `WAKE_ELIGIBLE` 消费结果）；不得绕过 Consumption。
5. **是否持久化？** **否**。
6. **是否排队？** **否**。
7. **是否调度？** **否**（无 timer / retry / backoff）。
8. **是否执行？** **否**（无 runtime / action / executor）。
9. **是否调用模型？** **否**（纯 / 确定）。
10. **是否进入 P25？** **否**——`Wake Request → Runtime → Planner → Action` 之后才轮到 P25 Autonomy。
