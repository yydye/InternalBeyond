# P26-9 · Activation Intent Contract

状态：**FOUNDATION / CONTRACT / PURE CORE / AUDIT-FIRST / NO PRODUCTION INTEGRATION**。
建立 `assets/js/activation-intent-core.js`（`IBActivationIntentCore`）。
**Production activation intent = 0**：Agent Runtime / Active Message / Diary / Role Letter /
Activity / Cinema / Voice / Middle Brain / P24 Group Runtime 全部零接线、零改动；
**没有** Agent Wake / Agent Start / Planner / Model / Action / P25 Autonomy / Queue /
Scheduler / Persistence / Event Bus。

---

## 1. Definition

> **Activation Intent = a pure intent object indicating that a runtime activation may be
> requested in the future.**

不是 Agent Wake · 不是 Agent Start · 不是 Planner Call · 不是 Action · 不是 Capability。
它只是**一个意图对象**：把"已经 `ACTIVATE_ELIGIBLE` 的运行时判定"表达成未来可请求的意图。

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
Wake Runtime
   │
   ▼
ACTIVATE_ELIGIBLE
   │
   ▼
Activation Intent      ← 本阶段（终点：Intent Creation）
   │
  STOP

（之后，未来阶段：）
Activation Intent ─▶ Agent Runtime ─▶ Planner ─▶ Action ─▶ P25 Autonomy ─▶ … ─▶ Executor
```

**P26-9 只到 Activation Intent。** STOP 之下的一切都不实现。

## 3. Intent Relationship

**`ACTIVATE_ELIGIBLE != Activation Intent`**：

| | ACTIVATE_ELIGIBLE（P26-8） | Activation Intent（P26-9） |
| --- | --- | --- |
| 是什么 | **runtime 判定**（enum） | **新的意图对象** |
| 身份 | 无（判定非实体） | activationIntentId（新身份） |
| 谁产出 | Wake Runtime | createActivationIntent（**仅从** ACTIVATE_ELIGIBLE） |

**允许** `ACTIVATE_ELIGIBLE → createActivationIntent`；**禁止** `Wake Request → Activation Intent`
（不得绕过 Wake Runtime），也禁止从 `BLOCKED` / `REJECTED` 创建。
实现上 `createActivationIntent(wakeResult, request, options)` 要求：

- `wakeResult.ok === true` 且 `wakeResult.activation === 'ACTIVATE_ELIGIBLE'`（否则 `not-activatable`）；
- `request.wakeRequestId === wakeResult.wakeRequestId`（否则 `request-mismatch`）；
- request 合法（委托 P26-7 的 `validateWakeRequest`）。

把裸 Wake Request 当作第一参数传入 ⇒ `invalid-wake-result`（守卫 A6）。

## 4. Identity

**审计结论：需要 `activationIntentId`**（§5）。与 P26-8 的**判定**不同，意图是**新对象**，
需要一个稳定身份在后续阶段被引用。生成方式：确定性
`'ai_' + stableToken(wakeRequestId|feedbackId|domain|source|reason|derivedFrom|causationId)`，
注入 `options.activationIntentId` 时优先。
**禁止**：random UUID · hidden timestamp（守卫 A2）。

## 5. Causation

```
Event ─▶ Feedback ─▶ Consumption ─▶ Wake Request ─▶ Wake Runtime ─▶ Intent
```

意图**保留**因果指针：`feedbackId`、`wakeRequestId`、`causationId`（options 优先，否则随
Wake Request 携带）、`derivedFrom`（随 Wake Request）。**不**设计完整 runtime trace。

## 6. State

**不引入 state**（§7：优先 no state）。`created / consumed / expired` 属于未来的队列生命周期，
本阶段不做意图队列，因此 Activation Intent 就是**一个纯对象**——无状态字段。

## 7. Runtime Boundary

Intent **不能**：start agent · call model · call planner · call autonomy · call authority
（守卫 A8–A13）。

## 8. P25 Boundary

Activation Intent **不是 Action**：P25 **不感知**它。零 P25 dependency（守卫 A12）。
激活词汇表**来自** P26-8（同一引用，不复制第二份，守卫 A7）。

## 9. Queue / Scheduler

**禁止** intent queue（守卫 A15）；**禁止** timer / retry / backoff（守卫 A16）。

## 10. Persistence

**禁止** intent store / activation history（守卫 A14）。`DB_VER` 与 store 列表逐字节未变（守卫 G2）。

## 11. Event Bus

**禁止** publish / subscribe / emit（守卫 A17）。

## 12. Pure API

刻意的极小面（守卫 G3 断言导出函数恰为三个）：

```js
createActivationIntent(wakeResult, request, options) // 唯一入口：从 ACTIVATE_ELIGIBLE 创建
validateActivationIntent(intent)                     // shape / 闭集 / 语法校验
describeActivationIntent(intent)                     // 无正文诊断摘要
```

常量：`ACTIVATION_INTENT_VERSION` / `ELIGIBLE_ACTIVATION` / `ACTIVATIONS`（**来自** P26-8）/
`ALLOWED_FIELDS` / `REQUIRED_FIELDS` / `OPTIONAL_FIELDS` / `OPTION_FIELDS` /
`POLICY_ONLY_FIELDS` / `RESERVED_BODY_FIELDS` / `ACTIVATION_INTENT_ERRORS`。

**禁止**：`ActivationManager` / `ActivationService` / `PolicyEngine`。
Wake Request 校验**委托** P26-7；激活词汇**来自** P26-8。确定性、JSON-serializable、深冻结。

## 13. Boundary Matrix

| Concern | Activation Intent Core owns? |
| --- | --- |
| activation intent identity | **YES** |
| causation pointers | **YES**（携带） |
| activation eligibility | **NO** — P26-8 |
| wake request validation | **delegated** — P26-7 |
| intent state machine | **NO** |
| intent queue / store | **NO** |
| scheduler / timer | **NO** |
| agent start / wake | **NO** |
| model call | **NO** |
| planner | **NO** |
| action creation | **NO** |
| autonomy / authority | **NO** |
| persistence | **NO** |
| event bus | **NO** |

## 14. Non-goals

不做：Agent Wake · Agent Start · Planner · Model · Action · P25 Autonomy · Authority ·
Queue · Scheduler · Persistence · Event Bus · Production Consumer。

---

## 附录 · Final Answers（Q1–Q10）

1. **Activation Intent 是什么？** 一个纯意图对象，表明未来可能请求一次 runtime activation。
2. **与 ACTIVATE_ELIGIBLE 区别？** 前者是**判定**（enum），后者是**新的意图对象**（新身份）。
3. **与 Agent Wake 区别？** 意图 ≠ 已唤醒；不启动 agent。
4. **谁创建？** 只能由 **Wake Runtime 的 ACTIVATE_ELIGIBLE** 结果创建；不得绕过。
5. **是否持久化？** **否**。
6. **是否排队？** **否**。
7. **是否调度？** **否**。
8. **是否执行？** **否**。
9. **是否调用模型？** **否**。
10. **是否进入 P25？** **否**——Activation Intent 不是 Action，P25 不感知。
