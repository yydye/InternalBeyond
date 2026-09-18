# Agent Runtime 架构

**Status: Canonical**
**Scope: 当前 AgentRuntime / Runtime Core / Model Execution Port 架构**

> 本文描述 InternalBeyond 当前的**模型执行框架**（AgentRuntime v2）。取信顺序：生产代码 → targeted 测试 →
> 既有 contracts → D11 审计 → 历史文档。若冲突，以代码为准。

---

## 1. 定义

`assets/js/agent-runtime.js` 是 **Runtime Core + Model Execution Port**：把“发起一次模型调用”抽象成
provider-neutral 的执行端口，并把回调 / 返回值 / 异常统一成 `ExecutionEvent`。

```text
Execution Framework ≠ Domain Authority
```

它**不是**自主 Agent：没有长时程规划、没有自由 tool loop、没有预算循环。自主行为边界见
[`../AUTONOMY.md`](../AUTONOMY.md)。

## 2. 系统位置

| 符号 | 职责 |
| --- | --- |
| `IB.runtime.instance` | `resolveModel()` + `execute(request, {signal,onEvent})` |
| `resolveModel()` | 产出 provider-neutral 的 **ModelSpec**（携带原始 cfg 给 ModelPort） |
| `execute()` | 通过注入的 **ModelPort** 执行；返回统一事件流 |
| default ModelPort | 一层 **Adapter**：包装 `callApiChatStream` / `callApiChat`，把回调/返回值/异常转成 `ExecutionEvent` |
| `IB.runtime.telemetry.record` | 统一 telemetry 入口（多 consumer 复用） |
| `IB.runtime.modelFormat` | 统一 format 解析（与 `provider-directory` 同源） |

## 3. Runtime Flow

```text
Consumer（diary / active-diary / moments / …）
        ↓
IB.runtime.instance.execute({spec, messages, budget, executor}, {signal,onEvent})
        ↓
resolveModel(cfg) → ModelSpec（provider metadata 唯一来源 provider-directory.js）
        ↓
ModelPort（默认 Aadapter → callApiChatStream / callApiChat）
        ↓
ExecutionEvent 事件流 → 调用方处理
```

## 4. 硬约束（写死在文件头）

- 不修改 `callApiChat` / `callApiChatStream` / `callApi` / `callCharacterModel`；
- 不修改 Memory / Moments / Letters / Proactive / Scheduler / Tool 系统；
- 不迁移 Chat（`sendChatMessage` 仍走既有 `callApiChatStream` / `callApiChat`）；
- 不新增 retry / autoContinue / FC / budget-fallback（这些属于上层执行语义）；
- Runtime / ModelPort **不触碰** DOM / streamRefs / `_showStreamingUI` / `_wsMakeStreamFilter`；
- 不改变任何既有函数行为（本模块是**能力叠加**，不是重构）。

## 5. Owner / Authority

Agent Runtime 是**执行框架**：它拥有“模型执行抽象”（ModelPort / ExecutionEvent / resolveModel），
但**不拥有**任何领域数据 authority（Chat 存储、Memory、Moments、Letters、Relationship、Disclosure 均不属于它）。

## 6. Boundary

- **Chat**：`sendChatMessage` 不经过 Agent Runtime（保持既有 seam）。
- **Memory / Moments / Letters / Relationship / Disclosure**：各自由其 canonical authority 拥有；Agent Runtime
  只是它们可能的执行方式之一。
- **Provider**：provider metadata 唯一来源是 `provider-directory.js`；Agent Runtime 只解析 format / ModelSpec，
  不定义 provider 表。
- **Autonomy**：自主行为（proactive / moments / reply chain 的边界）属于 [`../AUTONOMY.md`](../AUTONOMY.md) 与
  Companion 领域，不属于本执行框架。

## 7. UI Boundary

无 UI；纯执行框架。

## 8. Non-goals

不定义 agent loop、不定义 tool 执行、不定义预算/FC 语义、不定义领域 authority。

## 9. Enforcement

| 关注点 | 测试 |
| --- | --- |
| runtime 身份/收敛 | `tests/test_runtime_convergence_*`（diary / moments / proactive） |
| Agent 结构 | `tests/` 内 agent 相关 targeted 测试 |

## 10. Historical References

`assets/js/agent-runtime.js`（Runtime Core v2 + P1 ModelPort）；`docs/AUTONOMY.md`。
