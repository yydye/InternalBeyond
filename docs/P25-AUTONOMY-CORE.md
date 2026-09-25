# P25-1 · Autonomy Core Foundation

状态：**纯地基已建立（capability only）**。没有任何业务模块接入：
Moments / Diary / Active Message / Activity / Group Participation / role-to-role interaction **全部未接**。
Middle Brain、Memory、Group Brain 零引用；无模型调用、无 provider 调用、无 DB 变更（`DB_VER` 不变）。

实现位置：`assets/js/autonomy-core.js`（UMD 纯模块，浏览器暴露 `window.IBAutonomyCore`；Node 侧 `require`）。
测试：`tests/test_autonomy_core.js`（A1–A18 + 跨模块守卫）。

---

## 1. Purpose

Autonomy Core 只回答一个问题：

> **某个角色/模块想执行某个自主动作时，是否允许执行？**

标准流程（唯一入口）：

```
Action Candidate → Context Evaluation → Decision → Executor → Result Trace
```

它**不是** scheduler、**不是** message generator、**不是** AI agent loop、**不是** executor；
它不生成内容、不写业务数据、不决定产品频率策略。

## 2. Non-goals

- 不实现朋友圈发布 / 日记生成 / 主动消息 / Activity 启动；
- 不接 Group Brain / Middle Brain / Memory（未来只能是 recommendation 或 context，**不是 authority**）；
- 不做 LLM autonomy call、不做真实推送、不新增 DB store / schema / migration；
- 不迁移 P24（Group Runtime 未来只是本层的一个 Action Runtime 适配者）。

## 3. Action contract

```js
{
  actionType: 'moment.post' | 'diary.write' | 'active_message.send' | 'activity.start',
  actorId:    '<canonical id>',      // 角色/模块身份；不允许 displayName、不允许 'group_' 前缀
  source:     'user' | 'schedule' | 'character' | 'group_runtime' | 'system',
  context?:   { ... },               // 可选 plain object（只放动作所需的最小上下文）
  fingerprint?: '<business fingerprint>'   // 可选：去重/冷却的业务指纹
}
```

校验（`validateAutonomyAction`）返回闭集错误词表：
`not-an-object` / `missing-action-type` / `bad-action-type` / `missing-actor-id` / `bad-actor-id` /
`bad-source` / `bad-context` / `secret-in-action`（命中凭据形态 ⇒ 拒绝，且错误信息不回显原值）。

## 4. Decision contract

```js
AUTONOMY_DECISIONS = { ALLOW:'allow', DENY:'deny', DEFER:'defer' }   // 闭集
AUTONOMY_REASONS   = ['default-allow','invalid-action','cancelled','duplicate','cooldown',
                      'no-executor','decision-deny','decision-defer','decision-failure']   // 闭集
```

- 绝不接受自然语言 / 模型原文作为 decision；
- 决策顺序：**hard gates 先**（非法 action → `cancelled` → 无 executor → duplicate → cooldown），
  然后才是可选语义 decider（`ctx.decide`）；
- decider 返回未知词 / 非对象 / 抛错 ⇒ **DENY（`decision-failure`）**：裁决失败绝不导致执行。

## 5. Runtime boundary

`runAutonomyAction(state, action, ctx, executor)` 返回
`{ decision, reason, executed, ok, error, trace }`。

- **只有 allow 才调用 executor**；deny / defer ⇒ `executed:false` 且 executor 调用次数 = 0；
- Autonomy Core **不能**直接修改业务数据（不写 chatMessages / social / Moments / Diary）；
- runtime state（`createAutonomyState()`）= `{ trace: [], lastExecuted: {} }`，**只活在内存**。

## 6. Executor boundary

```js
evaluateAutonomyAction(state, action, ctx, executor) → { decision, reason }   // 只裁决
runAutonomyAction(state, action, ctx, executor)      → 裁决 + （allow 时）执行 + trace
```

- 本阶段 **executor 一律由调用方提供**（地基里没有业务实现，故测试使用 stub）；
- `executor` 缺席 ⇒ hard gate `no-executor`（DENY）；
- executor 抛错 ⇒ 被捕获为 `ok:false` + 截断错误文本（**不**上抛污染调用方、不落库、不回显凭据）。

## 7. Context boundary

`ctx` 允许：`now`（**必须注入**，本层无时钟）、`cancelled`、`decide`、`cooldownMsFor`、
`duplicateWindowMs`。禁止：API key、provider 配置、raw secret（action 侧同样禁止，见 §3）。
本层**不自动读取 Memory**：需要上下文时由调用方显式提供。

## 8. Trace boundary

```js
{ actionType, actorId, decision, reason, timestamp }   // timestamp = ctx.now（缺省 null）
```

- **runtime-only**：`memory = false` / `persist = false`；不进 IndexedDB / chatMessages / social；
- 环形上限 `AUTONOMY_TRACE_LIMIT = 50`（防无限增长）；
- trace 只是观测，**不是 authority**；`autonomyTraceSnapshot(state)` 返回只读副本。

## 9. Duplicate protection

- 指纹 = `stableToken(actionType + '|' + actorId + '|' + fingerprint)`（复用 chat-core 的哈希原语）；
- `isDuplicateAutonomyAction(state, action, ctx)`：同一 `actor + actionType + fingerprint` 在窗口内再次出现 ⇒ `true`；
- 默认窗口 `AUTONOMY_DUPLICATE_WINDOW_MS = 60000`，可被 `ctx.duplicateWindowMs` 覆盖（**不是**产品频率策略）；
- 未注入 `ctx.now` ⇒ 不做时间判定（保证确定性）；重复 ⇒ hard gate `duplicate`（DENY，executor 不执行）。
- 本阶段**不实现 scheduler**（没有定时器、没有队列、没有重试）。

## 10. Cooldown contract（只有接口）

```js
ctx.cooldownMsFor(action) → number   // 调用方注入的冷却策略；缺省 / 非法 / 抛错 ⇒ 视为无冷却
canExecuteAutonomyAction(state, action, ctx) → boolean
```

本层不绑定任何"每天几次"之类的具体策略（那属于产品 policy / 业务模块）。

## 11. Failure semantics

| 失败 | 结果 |
|---|---|
| action 非法 | DENY（`invalid-action`），executor 不执行 |
| `ctx.cancelled === true` | DENY（`cancelled`） |
| 无 executor | DENY（`no-executor`） |
| 重复（窗口内） | DENY（`duplicate`） |
| 冷却中 | DENY（`cooldown`） |
| decider 抛错 / 未知词 / 非对象 | DENY（`decision-failure`） |
| executor 抛错 | allow 已发生但 `ok:false`（捕获、不污染调用方） |
| 冷却来源抛错 | 不阻断（无冷却）——冷却不是许可 authority |

## 12. P24 boundary

P24 Dynamic Participation **属于未来的一种 Action Runtime**（`source:'group_runtime'` 已预留），但本阶段：

- **不迁移 P24**、不修改 `group-runtime-core.js` 与 `communication.js`（两者零耦合、零引用）；
- 未来的 P24 适配（Group Participation 作为 action）属独立阶段，且必须保持 planner v3 / runtime hard gates 不变。

## 13. MB / Memory relationship

```
Middle Brain recommendation ─┐
Memory context ──────────────┼→ Autonomy Decision → Executor
其它候选来源 ────────────────┘
```

- Middle Brain：未来只能**建议**（recommendation），不是 authority；本阶段 MB refs = 0；
- Memory：未来只能提供**上下文**，不是执行许可；本阶段 Memory refs = 0；
- Group Brain：**未实现**（0 引用）。

## 14. Persistence boundary

无新 DB store / schema / migration；`DB_VER` 保持不变；trace 与 lastExecuted 都是内存对象；
不写 localStorage / sessionStorage。

## 15. Future integrations（各自独立阶段）

| 目标 | 说明 |
|---|---|
| Moments | `actionType:'moment.post'` + executor 由 Moments 模块实现 |
| Diary | `actionType:'diary.write'` |
| Active Message | `actionType:'active_message.send'` |
| Activity | `actionType:'activity.start'` |
| Group Participation | `source:'group_runtime'`（P24 适配，需先冻结 action 语义） |
| role-to-role interaction | 需要先冻结身份与可见性契约 |
