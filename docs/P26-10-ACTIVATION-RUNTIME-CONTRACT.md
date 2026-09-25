# P26-10 · Activation Runtime Contract

状态：**FOUNDATION / CONTRACT / PURE CORE / AUDIT-FIRST / NO PRODUCTION INTEGRATION**。
建立 `assets/js/activation-runtime-core.js`（`IBActivationRuntimeCore`）。
**Production activation runtime = 0**：Agent Runtime / Active Message / Diary / Role Letter /
Activity / Cinema / Voice / Middle Brain / P24 Group Runtime 全部零接线、零改动；
**没有** Agent Runtime / Agent Wake / Model / Planner / Action / P25 Autonomy / Queue /
Scheduler / Persistence / Event Bus。

---

## 1. Definition

> **Activation Runtime = a runtime boundary that accepts Activation Intent and evaluates
> whether it may enter an agent activation pipeline.**

不是 Agent Runtime · 不是 Planner · 不是 Executor · 不是 Authority。
它只回答一个问题：**这条 Activation Intent 能否进入未来的 agent activation pipeline？**

## 2. Boundary Ladder

```
Feedback
   │
   ▼
Consumption
   │
   ▼
Wake Request
   │
   ▼
Wake Runtime
   │
   ▼
Activation Intent
   │
   ▼
Activation Runtime      ← 本阶段（终点：readiness 判定）
   │
  STOP

（之后，未来阶段：）
Agent Runtime ─▶ Planner ─▶ Action ─▶ P25 Autonomy ─▶ …
```

**P26-10 只到 Activation Runtime 的 readiness 判定。** STOP 之下的一切都不实现。

## 3. Responsibilities

**允许**：consume Activation Intent · validate intent · evaluate activation context ·
produce activation readiness result。
**禁止**：start agent · call model · create action · call planner · call authority ·
排队 · 调度 · 持久化 · 发事件。

## 4. Result Vocabulary（闭集）

```
READY  |  BLOCKED  |  REJECTED
```

| readiness | 语义 |
| --- | --- |
| **READY** | 意图**可进入**未来 agent activation pipeline（有资格，不是已启动） |
| **BLOCKED** | 暂时不可进入（运行时不可用 / 目标不可用）——条件未满足 |
| **REJECTED** | 不可进入（意图非法 / 上下文非法 / 已取消） |

**明确禁止** `ALLOW` / `DENY` / `EXECUTE`（守卫 B17）。`READY != Agent Start`。

## 5. Identity

**审计结论（§6）：不引入 `activationRequestId`。** 结果是对**已有 Intent** 的判定——
intent 已持有 `activationIntentId`，运行时**不再造第二个身份**。结果只**引用**
`activationIntentId` / `wakeRequestId` / `feedbackId`（守卫 B6）。
无 random UUID、无 hidden timestamp。

## 6. Context Boundary

context 是**闭集布尔字段**，全部由 caller **显式注入**：

| 字段 | 含义 |
| --- | --- |
| `runtimeAvailable` | 未来 agent activation pipeline 的运行时是否可用 |
| `targetAvailable` | 该 activation 的目标（角色/会话）是否可用 |
| `cancelled` | 现有取消语义；取消 ⇒ 意图作废（REJECTED） |

**禁止**：model · provider · prompt · memory dump · API key（列入 `FORBIDDEN_CONTEXT_FIELDS`，
显式 `forbidden-context-field` 拒绝，守卫 B19）。缺字段一律按 false（fail closed）。

判定顺序（deterministic；早期阶段先赢）：

```
1) intent 非法             → REJECTED / 'invalid-intent'
2) context 非法            → REJECTED / 'invalid-context'
3) cancelled               → REJECTED / 'cancelled'
4) targetAvailable != true → BLOCKED  / 'target-unavailable'
5) runtimeAvailable != true→ BLOCKED  / 'runtime-unavailable'
6) 否则                    → READY    / 'ready'
```

## 7. Agent Boundary

Activation Runtime **不能启动 Agent**：无 `createAgent` / `wakeAgent` / `runAgent`（守卫 B7）。
`READY` 只是"可进入未来 pipeline"的资格。

## 8. P25 Boundary

**不进入** Autonomy / Action / Authority（守卫 B10/B11/B12）。readiness 词汇与 P25 决策词汇
**不重叠**（守卫 B11 断言 `READINESS ∩ AUTONOMY_DECISIONS = ∅`）。零 P25 dependency。

## 9. Queue / Scheduler / Persistence

**禁止** queue（B13）· scheduler / retry / backoff（B14）· store / history（B15）。
`DB_VER` 与 store 列表逐字节未变（守卫 G2）。

## 10. Event Bus

**禁止** publish / subscribe / emit（守卫 B16）。

## 11. Pure API

刻意的极小面（守卫 G3 断言导出函数恰为三个）：

```js
evaluateActivationIntent(intent, context) // 唯一入口：纯评估
validateActivationContext(context)        // 校验闭集布尔 context
describeActivationResult(result)          // 无正文诊断摘要
```

常量：`ACTIVATION_RUNTIME_VERSION` / `READINESS` / `REASONS` / `CONTEXT_FIELDS` /
`FORBIDDEN_CONTEXT_FIELDS` / `ALLOWED_RESULT_FIELDS` / `ACTIVATION_RUNTIME_ERRORS`。

**禁止**：`ActivationManager` / `AgentStarter` / `WakeService` / `PolicyEngine`。
Intent 校验**委托** P26-9（唯一实现，不复制第二份）。确定性、JSON-serializable、深冻结。

## 12. Boundary Matrix

| Concern | Activation Runtime Core owns? |
| --- | --- |
| intent evaluation | **YES** |
| readiness disposition | **YES** |
| reason | **YES** |
| intent validation | **delegated**（P26-9） |
| runtime identity | **NO**（审计：复用 activationIntentId） |
| agent start / wake | **NO** |
| model call | **NO** |
| planner | **NO** |
| action creation | **NO** |
| autonomy / authority | **NO** |
| queue / scheduler | **NO** |
| persistence | **NO** |
| event bus | **NO** |

## 13. Non-goals

不做：Agent Runtime · Agent Wake · Model · Planner · Action · P25 Autonomy · Authority ·
Queue · Scheduler · Persistence · Event Bus · Production Consumer。

---

## 附录 · Final Answers（Q1–Q10）

1. **Activation Runtime 是什么？** 接受 Activation Intent 并评估其能否进入未来 agent activation pipeline 的运行时边界。
2. **与 Activation Intent 区别？** Intent 是**意图对象**；Runtime 对它的 **readiness 判定**（READY/BLOCKED/REJECTED）。
3. **与 Agent Runtime 区别？** 不启动 agent、不调模型——只产出判定。
4. **是否执行？** **否**。
5. **是否调用模型？** **否**。
6. **是否创建 Action？** **否**。
7. **是否进入 P25？** **否**（词汇不重叠，零依赖）。
8. **是否持久化？** **否**。
9. **是否排队？** **否**。
10. **是否调度？** **否**。
