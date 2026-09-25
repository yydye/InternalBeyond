# P26-5 · Feedback Contract

状态：**FOUNDATION / CONTRACT / PURE CORE / AUDIT-FIRST / NO PRODUCTION INTEGRATION**。
建立 `assets/js/feedback-core.js`。
**Production feedback = 0**：Cinema / Voice / Activity / Active Message / Role Letter / Autonomy Core /
Orchestration 全部零接线、零改动；**没有** Event Bus / Router / Scheduler / Agent Wake /
Autonomous Execution / Policy Engine / Feedback Store·History·Queue。

---

## 1. Definition

> **Feedback = a derived signal that evaluates whether existing facts or observations
> require further attention.**

不是 Event（发生了什么）· 不是 Observation（现在是什么）· 不是 Action · 不是 Command ·
不是 Decision（允许/拒绝）—— Feedback 只说"**这值得再看一眼**"。

## 2. Event Relationship

```
Event ──▶ Feedback may derive        （事件可以作为输入被派生）
Event  ≠  Feedback                   （事件是过去事实；Feedback 是对它的评估信号）
```
**不要**让 event listener 自动执行任何东西：订阅/派发/执行都不在本契约内
（守卫 F7 证明 core 内零 `emit` / `subscribe` / `dispatch` / `listener` / `router`）。

## 3. Observation Relationship

| 例子 | 是什么 |
| --- | --- |
| `camera unavailable`（`source:'device.camera'` + `valueRef:'#available'`） | **Observation**（现在是什么） |
| `reason:'camera-unavailable'` 的 feedback 信号（severity 可选） | **Feedback**（需要进一步注意） |

二者可以相邻（Feedback 可以 `derivedFrom` 一条 observation id），但**不是同一种东西**：
观察不申请动作、也不判断"是否需要关注"；Feedback 不描述状态，只表达"值得注意"。

## 4. Autonomy Boundary

Feedback **不执行 Capability**、**不调用 Authority**、**不创建 Action**（守卫 F9/F10）。
未来唯一合法链路：

```
Feedback ──▶ Autonomy Policy ──▶ Action（Capability → Authority → Executor）
```
本阶段**不实现** policy、也不实现这条链路的任何一环。

## 5. Agent Wake Boundary

**`Feedback Available ≠ Agent Wake`**：没有 `feedback.triggerAgent()`，
core 内零 `wake` / `trigger` / `notify` / `eligibility` 语义（守卫 F11）。
未来若需要唤醒，必须显式定义 Wake Eligibility Policy —— 那是后续阶段的事。

## 6. Feedback Contract（最小结构）

```
{
  feedbackId,      // REQUIRED  稳定身份（注入或确定性派生 'fb_…'）
  domain,          // REQUIRED  信号所在的域（token）
  source,          // REQUIRED  谁派生这个信号（点分标识，如 cinema.runtime）
  reason,          // REQUIRED  **机器可读的原因码**（token：小写字母/数字/-/_，≤60）
  timestamp,       // REQUIRED  派生时刻（number，注入；core 不读时钟）
  severity?,       // OPTIONAL  'low' | 'medium' | 'high'
  relatedEntity?,  // OPTIONAL  该信号所关于的实体（canonical id）
  derivedFrom?,    // OPTIONAL  派生自哪个 fact 的身份（event / observation / session id）
  version          // 由 core 固定写入 'feedback/v1'
}
```

**禁止**：full payload / canonical body / memory dump（`payload` / `content` / `body` /
`memory` / `memories` / `messages` / `history` / `images` / `audio` / `base64` / `dump` …
一律 `forbidden-body-field`）；未知字段同样拒绝。
`reason` 是**原因码而不是叙述**：自由文本/人类可读句子属 UI 与 policy，
不进入契约（这也避免 Feedback 变成第二个 CoT/正文通道）。

## 7. Priority Boundary（severity vs priority vs urgency）

| 概念 | 归属 | 理由 |
| --- | --- | --- |
| **`severity`** | **Feedback 契约**（闭集 `low`/`medium`/`high`） | 它是**信号自身的属性**：producer 已经做出的"这有多重要"评估 |
| **`priority`** | **Policy** | 它是**跨信号比较**（谁先处理）⇒ 需要全局视野，属 policy/scheduler |
| **`urgency`** | **Policy** | 同上：与时间压力、用户状态、会话上下文相关，不是信号自身属性 |

契约因此**明确拒绝** `priority` / `urgency` / `rank` / `schedule` / `deadline` / `retry`
（`policy-only-field`），并把它们列在 `POLICY_ONLY_FIELDS` 里 —— 不是为了以后偷偷加回来，
而是让"这是 policy 的东西"成为**可测试的边界**。本阶段不设计任何调度。

## 8. Identity

- `feedbackId` **注入优先**（`options.feedbackId`），未注入时由 core 确定性派生：
  `'fb_' + stableToken(domain|source|reason|relatedEntity|derivedFrom|timestamp)`；
- **无全局注册表 / 无随机 / 无隐藏时钟**（守卫 F5/F6）；
- 同一输入 ⇒ 同一 id（F4），因此 consumer 可以据此去重（Core 不提供去重存储）。

## 9. Persistence

**禁止** feedback store / history / queue（守卫 F12）：core 零 `dbPut` / IndexedDB / localStorage /
缓存 / 队列；`DB_VER` 与 store 列表未变（G9）。是否记录反馈是未来域策略。

## 10. Examples（EXAMPLE ONLY —— 生产 feedback = 0）

```
// 设备不可用（派生自一条 observation）
{ feedbackId:'fb_…', domain:'cinema', source:'cinema.runtime', reason:'camera-unavailable',
  severity:'high', relatedEntity:'act_1', derivedFrom:'obs_…', timestamp:1770000000000 }

// 用户长时间未回应（派生自角色互动事实）
{ feedbackId:'fb_…', domain:'active_message', source:'policy.reply', reason:'no-user-reply-24h',
  severity:'medium', relatedEntity:'role_a', timestamp:1770000000000 }

// 会话长时间停滞（派生自 session 状态）
{ feedbackId:'fb_…', domain:'voice', source:'voice.runtime', reason:'call-stalled',
  severity:'low', relatedEntity:'sess_…', timestamp:1770000000000 }

// 资源冲突被反复观察到（派生自仲裁结果）
{ feedbackId:'fb_…', domain:'resource', source:'policy.device', reason:'mic-conflict-repeated',
  severity:'high', relatedEntity:'role_a', timestamp:1770000000000 }
```

创建方式（纯函数）：

```js
IBFeedbackCore.createFeedback(
  { domain:'cinema', source:'cinema.runtime', reason:'camera-unavailable', severity:'high' },
  { timestamp: 1770000000000 }        // 时间与身份都可注入 ⇒ 测试完全确定性
);
```

## 11. Non-goals

本阶段**不**实现：Event Bus · Router · Scheduler · Agent Wake · Autonomous Execution ·
Policy Engine · Feedback Store / History / Queue · 反馈的消费与执行 · 跨进程反馈；
**不**接入 Cinema / Voice / Activity / Active Message / Role Letter / Autonomy Core /
Orchestration；**不**修改 P23/P24/P25 冻结栈与任何域生产代码；**不**新增 store / DB migration。

## 12. Boundaries With Frozen Contracts

| 已冻结契约 | 与 Feedback 的关系 |
| --- | --- |
| P26-1 Event | 事件可以**作为输入**被派生（`derivedFrom`），但 Event ≠ Feedback；本契约不订阅事件 |
| P26-2 Observation | 观察可以成为 Feedback 输入（例如 camera unavailable ⇒ 需要提醒）；Observation ≠ Feedback |
| P26-3 Session | 会话状态可以触发 Feedback（如 `call-stalled`）；Feedback 不拥有 Session 生命周期 |
| P26-4 Resource | 资源冲突可以产生 Feedback（如 `mic-conflict-repeated`）；Feedback 不做仲裁 |
| P25 Autonomy Core | Feedback **不**调用它；未来 `Feedback → Autonomy Policy → Action` 需另行设计 |
