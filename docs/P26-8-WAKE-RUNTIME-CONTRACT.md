# P26-8 · Wake Runtime Contract

状态：**FOUNDATION / CONTRACT / PURE CORE / AUDIT-FIRST / NO PRODUCTION INTEGRATION**。
建立 `assets/js/wake-runtime-core.js`（`IBWakeRuntimeCore`）。
**Production wake runtime = 0**：Agent Runtime / Active Message / Diary / Role Letter /
Activity / Cinema / Voice / Middle Brain / P24 Group Runtime 全部零接线、零改动；
**没有** Agent Wake / Model Call / Planner / Action / Autonomy / Authority / Queue /
Scheduler / Event Bus。

---

## 1. Definition

> **Wake Runtime = a runtime boundary that evaluates whether a Wake Request may proceed
> toward activation.**

不是 Agent Runtime · 不是 Planner · 不是 Executor · 不是 Authority · 不是 Scheduler。
它只回答一个问题：**这条 Wake Request 能否向未来的 activation 前进？**

## 2. Boundary Ladder

```
Feedback
   │
   ▼
Consumption
   │
   ▼
WAKE_ELIGIBLE
   │
   ▼
Wake Request
   │
   ▼
Wake Runtime          ← 本阶段（终点：Activation Decision）
   │
  STOP

（之后，未来阶段：）
Activation ─▶ Planner ─▶ Action ─▶ P25 Autonomy ─▶ Domain Authority ─▶ Executor
```

**P26-8 只到 Wake Runtime 的 activation 判定。** STOP 之下的一切都不实现。

## 3. Wake Runtime Responsibilities

**允许**：consume Wake Request · validate request · evaluate runtime conditions ·
produce activation result。
**禁止**：start agent · call model · create action · call authority · execute capability ·
排队 · 调度 · 持久化 · 发事件。

## 4. Activation Vocabulary（闭集）

```
ACTIVATE_ELIGIBLE  |  BLOCKED  |  REJECTED
```

| 激活结论 | 语义 |
| --- | --- |
| **ACTIVATE_ELIGIBLE** | 请求可向未来 activation 前进（**有资格**，不是已激活） |
| **BLOCKED** | 暂时不可前进（运行时不可用 / 已激活中）——非拒绝，是条件未满足 |
| **REJECTED** | 不可前进（请求非法 / 上下文非法 / 已取消） |

**明确禁止** `ALLOW` / `DENY` / `EXECUTE`（避免与 P25 Autonomy 冲突，守卫 W17）。
`ACTIVATE_ELIGIBLE` 不是授权，也不是执行。

## 5. Wake Request Relationship

**`Wake Request != Wake Runtime`**：前者是**请求对象**，后者是对它的**评估**。
`Wake Request → Wake Runtime` 是 **request evaluation**，**不是** permission check，
也**不是** action decision（守卫 W8/W22）。实现上 `evaluateWakeRequest` 把请求校验
**委托**给 P26-7 的 `validateWakeRequest`（唯一实现，不复制第二份校验器）。

## 6. Context Boundary

context 是**闭集布尔字段**，全部由 caller **显式注入**（§7：explicit injected）：

| 字段 | 含义 |
| --- | --- |
| `runtimeAvailable` | 未来 activation 的运行时是否可用（context 事实，非投递/scheduler） |
| `cancelled` | 现有取消语义；取消 ⇒ 请求作废（REJECTED） |
| `alreadyActive` | 该信号是否已在激活中（caller 事实，避免重复激活 ⇒ BLOCKED） |

**禁止**：API key · provider · model · prompt · memory dump（列入 `FORBIDDEN_CONTEXT_FIELDS`，
显式 `forbidden-context-field` 拒绝，守卫 W20）。缺字段一律按 false（fail closed）。

判定顺序（deterministic；早期阶段先赢）：

```
1) request 非法          → REJECTED / 'invalid-request'
2) context 非法          → REJECTED / 'invalid-context'
3) cancelled             → REJECTED / 'cancelled'
4) alreadyActive         → BLOCKED  / 'already-active'
5) runtimeAvailable≠true → BLOCKED  / 'runtime-unavailable'
6) 否则                  → ACTIVATE_ELIGIBLE / 'activate-eligible'
```

## 7. Session Relationship

Session **可以**作为 context 事实——但 Wake Runtime **不创建 Session**：不 `startSession`、
不 `endSession`、不依赖 `session-core`（守卫 W14）。`sessionActive` **不在** context 闭集里
（传入即 `unknown-field` 拒绝）。

## 8. Resource Relationship

Wake Runtime **不仲裁 Resource**。resource availability 只能作为 context 事实，
**不能** grant / lease / lock（守卫 W15）。`resourceAvailable` 不在 context 闭集里。

## 9. Autonomy Boundary

**`Wake Runtime != Autonomy Core`**：

| | Wake Runtime（P26-8） | P25 Autonomy |
| --- | --- | --- |
| 决定什么 | 是否进入未来 **activation** | **Action** 是否执行 |
| 输入 | Wake Request + runtime context | Action |
| 输出 | ACTIVATE_ELIGIBLE / BLOCKED / REJECTED | ALLOW / DENY / DEFER |
| permission | **NO** | YES |
| execution gate | **NO** | YES |

激活词汇与 P25 决策词汇**不重叠**（守卫 W7 断言 `ACTIVATIONS ∩ AUTONOMY_DECISIONS = ∅`）。
零 P25 dependency。

## 10. Queue Boundary

**禁止** wake queue / pending wake / retry queue（守卫 W10）。结果只是一个判定，不入队。

## 11. Scheduler Boundary

**禁止** timer / cron / retry / backoff（守卫 W11）。

## 12. Persistence Boundary

**禁止** wake state store / activation history / wake database（守卫 W12）。
`DB_VER` 与 store 列表逐字节未变（守卫 G2）。

## 13. Event Bus Boundary

**禁止** publish / subscribe / consume（守卫 W13）。Wake Runtime 不订阅也不发事件。

## 14. Identity

**审计结论：不引入 `activationId`**（§15）。activation 结果是**判定**而非**实体**，
没有需要跨阶段追踪的身份，因此不造身份、不用 random UUID。
审计留痕：源码/结果里**没有** `activationId`，也没有 `uuid` / `Math.random`（守卫 W19）。

## 15. Causation

结果**保留**因果指针：`feedbackId`（随请求）、`wakeRequestId`（随请求）、
`causationId`（请求携带时回显）。**不**设计完整 trace system。

## 16. Pure API

刻意的极小面（守卫 G3 断言导出函数恰为三个）：

```js
evaluateWakeRequest(request, context)  // 唯一入口：纯评估
validateWakeContext(context)           // 校验闭集布尔 context
describeWakeResult(result)             // 无正文诊断摘要
```

常量：`WAKE_RUNTIME_VERSION` / `ACTIVATIONS` / `REASONS` / `CONTEXT_FIELDS` /
`FORBIDDEN_CONTEXT_FIELDS` / `ALLOWED_RESULT_FIELDS` / `WAKE_RUNTIME_ERRORS`。

**禁止**：`WakeManager` / `WakeService` / `ActivationScheduler` / `PolicyEngine`。
确定性：同输入同结果；无时钟/随机/隐藏状态（守卫 W3/W18）。JSON-serializable、深冻结。

## 17. Boundary Matrix

| Concern | Wake Runtime Core owns? |
| --- | --- |
| wake request evaluation | **YES** |
| activation disposition | **YES** |
| reason | **YES** |
| wake request validation | **delegated**（P26-7 唯一实现） |
| activation identity | **NO**（审计：不需要） |
| agent execution | **NO** |
| model call | **NO** |
| planner | **NO** |
| action creation | **NO** |
| permission | **NO** |
| capability | **NO** |
| queue | **NO** |
| scheduler | **NO** |
| persistence | **NO** |
| event bus | **NO** |
| session mutation | **NO** |
| resource arbitration | **NO** |

## 18. Examples

仅 contract examples，**不生产接线**：

| Case | 输入 | 期望 |
| --- | --- | --- |
| **A** | 合法请求 + `{runtimeAvailable:true}` | `ACTIVATE_ELIGIBLE`（`activate-eligible`） |
| **B** | 合法请求 + `{}` | `BLOCKED`（`runtime-unavailable`） |
| **C** | 合法请求 + `{runtimeAvailable:true,alreadyActive:true}` | `BLOCKED`（`already-active`） |
| **D** | 合法请求 + `{cancelled:true}` | `REJECTED`（`cancelled`） |
| **E** | 非法请求 / 非法 context | `REJECTED`（`invalid-request` / `invalid-context`） |

## 19. Non-goals

不做：Agent Wake · Model Call · Planner · Action · Autonomy · Authority · Executor ·
Queue · Scheduler · Event Bus · Production Consumer · 任何持久化 / 时钟 / 随机。

---

## 附录 · Final Answers（Q1–Q10）

1. **Wake Runtime 是什么？** 评估"一条 Wake Request 能否向未来 activation 前进"的运行时边界。
2. **与 Wake Request 区别？** Request 是**对象**；Runtime 对它的**评估**（ACTIVATE_ELIGIBLE/BLOCKED/REJECTED）。
3. **与 Agent Runtime 区别？** 不启动 agent、不调模型——只产出判定。
4. **是否执行？** **否**。
5. **是否调用模型？** **否**。
6. **是否创建 Action？** **否**。
7. **是否进入 P25？** **否**（激活词汇与 P25 决策不重叠，零依赖）。
8. **是否持久化？** **否**。
9. **是否排队？** **否**。
10. **是否调度？** **否**（无 timer / cron / retry / backoff）。
