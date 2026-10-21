# Memory Recall Contract

**Status: Canonical**
**Scope: Memory Recall Orchestration —— turn 决策、channel、query、relevance、gate、seat、exploration、cooldown、budget、trace**

> 本 contract 固定 **Memory Recall Orchestration** 的语义边界、词表与不变量。
> 它**不**固定具体算法、**不**固定数值阈值、**不**改变任何 runtime 行为。
>
> 相关文档：
> - record 形状 → [`MEMORY_RECORD_CONTRACT.md`](MEMORY_RECORD_CONTRACT.md)
> - storage authority / mirror → [`MEMORY_AUTHORITY_CONTRACT.md`](MEMORY_AUTHORITY_CONTRACT.md)
> - 迁移水位 → [`MEMORY_MIGRATION_CONTRACT.md`](MEMORY_MIGRATION_CONTRACT.md)
> - mirror hydration → [`MEMORY_SYNC_CONTRACT.md`](MEMORY_SYNC_CONTRACT.md)
> - 当前架构 → [`../../architecture/MEMORY.md`](../../architecture/MEMORY.md)
>
> **Source-of-truth 优先级：生产代码 → enforcement tests → 当前 contracts → audit → history。**
> 本文件是 **contract（约束）**，不是 audit（现状描述）。当本文件与生产代码冲突时，
> 以生产代码为准，并据此修正本文件 —— 但**不得**为了让某条契约"看起来已生效"而
> 提前修改生产代码。尚未有生产实现支撑的条款一律标注 **FUTURE CONTRACT**。

---

## 0. 本轮的定位（P21-R2-A）

**P21-R2-A 只冻结契约、不实现。** 本文件描述的 Recall Orchestrator 在 R2-A 时点
**尚不存在**：生产召回仍然是 `assets/js/memory-retrieval-core.js` 的
`buildMemoryContext()` 单一管线，由 `assets/js/memory.js`
`getMemoryContext()` 调用。

因此本文件中：

- **MUST / MUST NOT** 描述的是**未来实现必须满足的约束**；
- 标注 **FUTURE CONTRACT** 的条款在 R2-A 时点**没有生产实现**，
  对应的测试以 static assertion 或 fixture 形式钉住契约文本与接口形状，
  **不**要求生产行为已经改变；
- 未标注 FUTURE 的条款是**当前已成立**且改造后**必须继续成立**的不变量。

R2-A **不修改** `assets/js/**` 下任何文件、不修改 Home Node service、
不新增 store、不 bump `DB_VER`、不新增依赖。

---

## 1. Scope

### 1.1 Memory Recall Orchestration **负责**

| 职责 | 含义 |
|---|---|
| turn 决策 | 当前 turn 是否进行 recall |
| channel 选择 | 使用哪一个 recall channel |
| query construction | 从 turn 输入构造确定性检索 query |
| relevance | 候选与本轮 query 的相关性判定 |
| hard gate | 候选是否有资格进入注入 |
| seat allocation | 注入席位分配 |
| exploration policy | 未入选候选的有限浮现机会 |
| cooldown policy | 抑制连续重复浮现 |
| budget composition | 在既有字符预算内组合各通道产出 |
| recall trace | 本轮召回的可解释记录 |

### 1.2 Memory Recall Orchestration **不负责**

| 不负责 | 归属 |
|---|---|
| 创建 Memory | Consolidation / producers（见 `../../architecture/MEMORY.md`） |
| Consolidation | browser-side consolidation 过程 |
| Storage Authority | Home Node `memory_records`（见 `MEMORY_AUTHORITY_CONTRACT.md`） |
| ACL 定义 | [`memory-visibility-core.js`](../../../assets/js/memory-visibility-core.js) |
| Summary 生成 | conversation summary 子系统（独立于长期记忆） |
| Auto Memory 的存储与独立注入管线 | 见 §9，**独立管线**，不属本 contract |

> **边界原则**：Recall **读取** memory，从不**创建**或**修改内容**。
> 召回的唯一持久化副作用是**激活簿记**（reinforcement），
> 且它由调用方在**选择之后**单独执行（selection / reinforcement 分离），
> 不属于 orchestration 决策本身。

---

## 2. Existing Authority（本 contract 不改动）

```
                    canonical（durable）
              Home Node  memory_records
                        │
          ┌─────────────┴─────────────┐
          ▼                           ▼
  Browser IndexedDB `memories`    Mobile: (none)
  mirror / migration source /
  rollback shadow
  = desktop recall 候选集
```

**MUST**：

- Home Node `memory_records` 是 durable canonical；浏览器 IndexedDB `memories`
  是 mirror（同时是 desktop 的 recall 候选来源）。
- Recall Orchestration **MUST NOT** 迁移 storage authority，
  **MUST NOT** 让 mirror 成为 durable authority，
  **MUST NOT** 绕开 authority 写入。

**P21-R2 范围内 storage authority 不变。** 详见
[`MEMORY_AUTHORITY_CONTRACT.md`](MEMORY_AUTHORITY_CONTRACT.md) §1-§3。

---

## 3. Visibility Invariant（本 contract 的核心不变量）

### 3.1 顺序契约

```
candidate set
   ↓  ① visibility / ACL        ← MUST 先于此后的**全部**步骤
   ↓  ② query construction
   ↓  ③ relevance
   ↓  ④ scoring / memoryValue
   ↓  ⑤ hard gate
   ↓  ⑥ budget composition（main 区填充；pinned-first）
   ↓  ⑦ exploration（只使用 `payloadBudget` 的余量）
   ↓  ⑧ seat allocation（seat cap 在 core 选择**之后**截断）
   ↓  ⑨ rendered context
   ↓  ⑩ trace candidate detail
```

> **顺序事实（R2-G1 校正）**：⑥⑦⑧ 的**实际执行顺序**是
> `budget composition(main) → exploration → seat cap`。
> 唯一 selector（[`memory-retrieval-core.js`](../../../assets/js/memory-retrieval-core.js)）
> 先确定 main / reserved 预算并完成 main 区填充；exploration 只能消费 `payloadBudget` 的余量；
> seat planner 在 core 返回**之后**才做席位截断，且冻结的 seat 契约要求它**不得**重新解释预算。
> 本次校正**只改文档的顺序描述**，不改变下面任何 MUST / MUST NOT 语义，
> 也不改变 §9 Exploration Contract。

**MUST**：visibility filtering MUST occur before **relevance、scoring、ranking、
seat allocation、exploration、budget composition、trace candidate detail**。

**MUST NOT**：被 ACL 拒绝的 memory **不得**进入 trace 的 candidate detail ——
包括其标题。只允许以**计数**或 **opaque id**（内部标识，不含正文）表达。

**理由（既有机制）**：隐藏记忆一旦进入打分/排序，就会影响 top-k 的构成，
从而泄漏"存在一条与你有关的、但我不能说的记忆"。当前生产实现已在
[`memory-retrieval-core.js`](../../../assets/js/memory-retrieval-core.js)
的 `rankMemoryCandidates()` 第一步完成该过滤，且有一份执行级对照实验
（加入 20 条分数更高但不可见的记录后输出逐字节相同）。

### 3.2 唯一 ACL

**MUST**：memory 可见性的**唯一**实现是
[`assets/js/memory-visibility-core.js`](../../../assets/js/memory-visibility-core.js)
的 `isMemoryVisibleTo()`。

**MUST NOT**：建立第二套 ACL、第二套可见性档位、或"为了召回方便"在
orchestration 层复制一份可见性判断。

### 3.3 fail closed

**MUST**：

- `visibility` **缺失** → 判**不可见**（绝不补默认值，绝不解析为 `public`）；
- `visibility` **格式错误 / 未知档位** → 判**不可见**；
- 可见性判定自身抛错 → 判**不可见**；
- 可见性核心**不可用** → 不注入任何记忆，并以
  `visibility-unavailable` 如实上报（见 §11）。

**MUST NOT**：把"无法判定可见性"变成"对外公开"。

### 3.4 character / group scope

**MUST**：记忆的 character / group 归属继续**只**由 `visibility` 与
`visibleTo` / `excludeFrom` 表达；读主体（viewer）由调用方以角色 id 传入。

**MUST NOT**：为 recall 新增 scope 字段（例如 `scope`、`conversationId` 归属）
来替代 visibility 判定。

---

## 4. Recall Channel Vocabulary

### 4.1 词表（冻结）

| channel | 产品语义 | 触发 |
|---|---|---|
| `legacy` | **兼容通道**。用于旧调用方 / 未提供 turn signal 的路径，保持改造前的选择与渲染行为 | 调用方未提供 turn / recall signal |
| `surface` | 普通聊天中的少量相关记忆浮现 | 默认通道 |
| `recall` | 用户或角色**明确主动回忆**时的更强检索 | 显式回忆信号 |
| `glossary` | 人名、暗号、专名、梗、缩写、固定定义 —— 优先 deterministic exact / alias lookup | 专名 / 别名命中 |
| `coldStart` | 会话开始时恢复身份、关系、长期核心事实 | 会话开启 |
| `reminisce` | 没有直接查询时，偶尔让长期沉睡记忆重新浮现 | Presence / Reverie / 主动消息 |

**`legacy` 的地位**：它不是产品通道，而是**兼容通道**。
当调用方没有提供新的 turn / recall signal 时，orchestration 必须进入
`legacy` 语义（见 §12）。

### 4.2 Policy 形状（冻结形状，**不**冻结数值）

```text
RecallChannelPolicy {
  gate          //  该通道的准入判定
  seats         //  该通道的席位分配
  cooldown      //  该通道的抑制策略
  budgetShare   //  该通道在总字符预算中的份额
  exploration   //  该通道是否允许 exploration，及其策略
}
```

**MUST NOT**：在本 contract 中写死未经数据校准的数值
（席位条数、冷却轮数/天数、阈值分数、预算百分比等）。

**理由**：这些数值必须来自真实分布的校准。在分布式数据到位前写死，
会得到一个"看起来精确、实际无依据"的契约，并让后续校准变成违约。

**允许**在本 contract 中冻结的是：**词表**、**形状**、**不变量**、**理由**。

---

## 5. Early Exit Contract

某些 turn **可以合法地不启动 recall**。

**FUTURE CONTRACT**：

```text
early exit 的结果形状：
  consulted = false
  selected  = []
  text      = ''
  reason    = 'early-exit'
```

**MUST**：

- Early exit **不是** error、**不是** degraded、**不是** runtime failure。
  它是"本轮无需召回"这一**正常结论**。
- Early exit **MUST** 与"执行了召回但没有命中"（`gate-rejected`）区分开，
  二者对诊断的含义完全不同（前者是策略选择，后者是候选库与 query 的匹配结果）。
- Early exit 时**不得**产生任何激活写入（没有 selection，就没有 reinforcement）。

**本轮不冻结**：哪些短语/形态触发 early exit。
该分类属于 **R2-B**，且必须是**确定性规则**，不依赖 Middle Brain / LLM。

---

## 6. Hard Gate Contract

### 6.1 核心命题

> **0 memory is a valid successful recall result.**

一次召回返回 **0 条注入**，是**正常且成功**的结果，不是错误、不是降级、
不是"没找到所以退化到别的行为"。

### 6.2 三种"零结果"必须可区分

| 状态 | 含义 | 是否需要执行召回 | 是否 runtime failure |
|---|---|---|---|
| `early-exit` | 没有启动 recall | 否 | **否** |
| `gate-rejected` | 执行了 recall，但没有候选满足门槛 | 是 | **否** |
| `no-visible-memory` | ACL 过滤后没有可见候选 | 是 | **否** |

**MUST**：三者在 result 上以**不同的 `reason`** 表达，不得塌缩为同一个值。

**MUST NOT**：把上述任一状态标记为 error / degraded / failure。

### 6.3 relevanceScore 的值域

**FUTURE CONTRACT**：relevance 判定接口的形状：

```text
scoreRelevance(memory, query, context) → {
  score:   number,
  signals: { ... }        // 命中了哪些证据（exact / alias / tag / entity / temporal / lexical）
}
```

**MUST**：`score` 的值域**必须包含 0**，且 `score === 0` **必须**能够表达
"**没有任何相关证据**"。

**MUST**：`score === 0` 的候选**不得**通过 gate。

**MUST NOT**：让 relevance 的值域下限恒为正数（例如恒 `≥ 1`）。
一个恒正的 relevance 在数学上不可能形成门槛，
这会使"0 memory is valid"无法成立 —— 无论预算多小，
总会有候选被"取满"。

**本轮不冻结**：relevance 的具体公式、证据分档与分值。
具体算法属于后续阶段，且必须与本节的值域约束相容。

> **当前生产状态（如实记录，非契约）**：现行
> [`memory-retrieval-core.js`](../../../assets/js/memory-retrieval-core.js)
> 的 `calcRelevance()` 值域为 `[1, 2.5]`（`1 + ratio × 1.5`），
> **下限恒为 1，无法表达 0**。因此当前实现**不满足** §6.1-§6.3，
> 这正是 R2-C 要处理的核心问题。R2-A 不修改它。

---

## 7. Memory Value Contract

### 7.1 两个概念必须分离

| 概念 | 回答的问题 | 是否依赖 query |
|---|---|---|
| `relevanceScore` | "这条记忆与本轮查询有多相关？" | **是** |
| `memoryValue` | "这条记忆本身有多值得浮现？" | **否** |

**MUST**：`relevanceScore` 与 `memoryValue` 是**两个独立概念**，
不得互相替代、不得让其中之一独自决定注入。

### 7.2 LegacyMemoryValue（兼容定义）

**MUST**：本 contract 冻结

```text
LegacyMemoryValue(mem, now) ≡ 当前生产 getMemoryScore(mem, now) 的逐行为语义
```

即：`importance × activationFactor × decayFactor × emotionFactor`，
`pinned → 999`，各因子沿用
[`memory-retrieval-core.js`](../../../assets/js/memory-retrieval-core.js)
`getMemoryScore()` 的现行定义。

**MUST NOT**：在 R2-A / R2-B / R2-C / R2-D **修改 LegacyMemoryValue 的数值行为**。

**理由**：LegacyMemoryValue 是**兼容基准**。任何数值变化都必须是一个
**被显式宣布的 semantic cutover**，而不是夹在重构里顺手发生的漂移。
在 cutover 之前，legacy path 与新旧路径的 parity 必须成立（见 §12）。

### 7.3 MemoryValueV2（预留，未实现）

**FUTURE CONTRACT**：允许在**独立的、可测试的、可 A/B 的**后续阶段引入
`MemoryValueV2`，其可调项**至少**包括：

- **decay anchor** —— 衰减的时间基准；
- **activation reinforcement** —— 激活对排序的贡献强度；
- **cooldown interaction** —— 冷却与价值排序的交互；
- **resolved decay semantics** —— 已解决记忆的加速衰减语义。

**MUST**（引入 V2 时的前置条件）：

1. 有**独立测试**证明 V2 的行为边界；
2. 有**行为变更记录**（哪些字段的分数会变、往哪个方向变）；
3. 有 A/B 或分布校准数据支撑；
4. 明确宣布 semantic cutover 的时点与回滚方式。

**已知动机（记录，不裁决）**：现行 `getMemoryScore()` 的 `decayFactor`
以 `lastActivated` 为时间锚点，因此"被召回"同时产生两个正反馈
（提高 `activationFactor` **并且**把衰减时钟重置到当下）。
两者量级差异显著，且后者更强。是否调整锚点属于 `MemoryValueV2` 的裁决范围，
**不属于 R2-A**。

---

## 8. Selection Contract

**MUST**：selection **不得**等价于无条件

```text
sort().slice(0, N)
```

**理由**：`sort().slice(0, N)` 隐含三个本 contract 明确拒绝的性质：
(i) 一定会取满 N 条（与 §6 冲突）；(ii) 席位不可区分；
(iii) 预算不可表达（取满 N 条 ≠ 放得进预算）。

**MUST**：选择层**至少**能够表达以下席位语义：

| 席位语义 | 说明 |
|---|---|
| `pinned` | 显式置顶（用户意图） |
| `normal relevant` | 过 gate 的普通相关记忆 |
| `exploration` | 未进入正常高相关选择的候选的有限机会 |
| `glossary` / `exact` | 专名 / 别名精确命中 |
| `protected` / `new` | 新记忆保护 |
| `dormant` | 久未浮现 |

**MUST NOT**：在 R2-A 创造多余的 scope 字段。
character / group 归属**继续由 visibility 表达**（见 §3.4）。

**数值不冻结**：各席位的条数与预算份额属于后续阶段。

---

## 9. Exploration Contract

**保留 exploration 概念。** 这是从旧设计继承的**有价值机制**，不因重构而删除。

**MUST**：exploration 的**目标**定义为

> 给予**未进入正常高相关选择**的候选**有限**机会。

**MUST NOT**：把 exploration 定义为

> "从 remaining 的**最高分前 N 条**中随机取一条"。

**理由**：后者在语义上不是"唤起沉睡"，而是"在热门中再抽一次"——
它不增加候选的**覆盖**，只增加**不确定性**。当 remaining 保持按分数降序时，
索引前缀恰是分数最高的一段，采样区间因此**与目标相反**。

**MUST**：exploration **MUST** 是**有界**的（不能每次都注入），
且其决策必须是**可复现**的（随机源必须**注入**，不得从全局读取）。

**通道差异（形状，非数值）**：

| channel | exploration |
|---|---|
| `surface` | 允许 |
| `reminisce` | 允许（且是其主要机制） |
| `recall`（显式主动回忆） | 允许关闭 |
| `glossary` | **关闭**（确定性 lookup，不得引入随机） |

**具体算法放后续阶段。**

---

## 10. Cooldown Contract

### 10.1 R2 当前冻结：session-local

**MUST**：R2-B ~ R2-F 的 cooldown 默认使用 **RecallSessionState**：

```text
RecallSessionState {
  byMemoryId: {
    [memoryId]: {
      lastSurfacedAt?: timestamp,
      lastRecalledAt?: timestamp,
      lastChannel?:   RecallChannel
    }
  }
}
```

**RecallSessionState 的性质（冻结，均为 MUST NOT）**：

| 性质 | 状态 |
|---|---|
| session-local | **是** |
| runtime-local | **是** |
| MemoryRecord content | **不是** |
| canonical field | **不是** |
| IndexedDB schema | **不是** |
| Home Node promoted column | **不是** |
| 参与 `contentFingerprint` | **不参与** |
| 重启后保留 | **不保证**（重启可丢失） |
| 跨设备一致 | **不保证** |

**MUST**：以上是**显式的产品语义**，**不是** degraded、不是 failure、
不是"临时凑合"。会话内不重复浮现，本身就是一个成立的语义
（"这次对话里她已经提过一次了"）。

### 10.2 durable cooldown 后置

**FUTURE CONTRACT**：跨端持久的 cooldown（把 recall telemetry 提升为
durable MemoryRecord 字段）**必须**经过独立的
**R2-H · Authority Closure** 裁决，并满足 §13.2 的 telemetry exclusion 前置条件。

**MUST NOT**：在 R2-B ~ R2-F 期间提前把 cooldown telemetry 写进 MemoryRecord。

---

## 11. Result Reason Vocabulary

### 11.1 现有词表（冻结，**不得静默改义**）

以下枚举取自当前生产代码（`grep` 取证，非文档转述）：

| reason | 出处 | 含义 |
|---|---|---|
| `null` | [`memory-retrieval-core.js`](../../../assets/js/memory-retrieval-core.js) `buildMemoryContext()` 成功返回 | 有注入 |
| `'no-visible-memory'` | 同上 | ACL 之后没有可见候选 |
| `'no-budget'` | 同上 | 有可见候选但预算放不下任何一条 |
| `'visibility-unavailable'` | 同上 | 可见性不可判定 → fail closed，不注入 |

**MUST**：上述四个值**保留**，语义**不变**。
特别地：`reason === ''`/`null` 表示"不注入"的既有契约不变
（调用方据此决定是否拼接标题）。

> 相关但**不同层**的 reason 枚举（不得与本 contract 的这一层混用）：
> Home Node 的 `memoryReason` 在 `memory-store-unavailable` /
> `context-failed` 时回退为 **error code**（见
> [`services/home-node/memory-retrieval.js`](../../../services/home-node/memory-retrieval.js)
> `buildMemoryBlock()`），它不是召回结论而是故障标识。

### 11.2 新增（FUTURE CONTRACT）

| reason | 含义 | 是否 failure |
|---|---|---|
| `'early-exit'` | 本轮未启动 recall（见 §5） | **否** |
| `'gate-rejected'` | 执行了 recall，但没有候选通过 gate（见 §6） | **否** |

**MUST**：两个新值**只增不改** —— 不得复用、不得重定义既有值。

### 11.3 三态可区分性（可断言）

| 场景 | 期望 reason |
|---|---|
| 未启动 recall | `'early-exit'` |
| 启动了 recall、候选为空（ACL 后） | `'no-visible-memory'` |
| 启动了 recall、有候选、全部被 gate 拒绝 | `'gate-rejected'` |
| 启动了 recall、有候选过 gate、但预算放不下 | `'no-budget'` |
| 可见性不可判定 | `'visibility-unavailable'` |
| 有注入 | `null` |

---

## 12. Legacy Compatibility Contract

**这是 R2-C 的 parity safety belt。**

**MUST**：当调用方**没有**提供新的 turn / recall signal 时，
orchestration **MUST** 进入 `legacy` 语义，并满足：

```text
给定相同 fixture、相同 clock、相同 random、相同 candidates：

  selected IDs  →  与改造前相同
  text          →  与改造前逐字节相同
  reason        →  与改造前相同
```

**MUST**：该 parity 必须是**可断言的**（同一输入 → 同一输出），
而不是"看起来差不多"。可复现性依赖的 `now` 与 `random`
**MUST** 由调用方注入（既有约定），不得从全局读取。

**MUST NOT**：在 semantic cutover（§7.3）宣布之前，
让 legacy path 的输出发生任何变化。

**理由**：当前"browser 与 Home Node 共用唯一实现"的一致性契约
依赖两侧对同一输入给出同一结果。任何未经 parity 验证的接线，
都会让"两端各记一套"重新变成可能，且不会立刻被发现。

---

## 13. Trace Contract

### 13.1 数据形状（FUTURE CONTRACT，冻结形状）

```text
RecallTrace {
  version
  channel
  earlyExit
  earlyExitReason

  query: {
    lexicalTerms
    entities
    temporalHints
    aliases
  }

  counts: {
    input            // 候选集大小
    visible          // ACL 之后
    gated            // 通过 gate
    selected         // 实际注入
  }

  candidates: [
    {
      memoryId
      relevanceScore
      memoryValue
      cooldownFactor
      finalScore
      seat
      decision         // selected | rejected
      reasons[]        // 稳定、可断言的拒绝/选入原因
    }
  ]

  budget: {
    maxChars
    usedChars
  }

  reason
}
```

**MUST**：允许 `selected === 0`（见 §6）。trace 必须能表达"本轮合法的 0 条"。

### 13.2 Trace 的强制脱敏要求

**MUST NOT** 出现在 trace 中：

- memory content **全文**；
- API Key / credential / token；
- system prompt；
- **私有 / 隐藏记忆的正文**。

**MUST**：对于在 ACL 阶段已被拒绝的 memory，**不得**让其内容进入
trace 的 candidate detail。**最好连标题也不进入** —— 只允许
**计数**或 **opaque id**（内部标识）表达，以保持 SAFE_PRE_FILTER。

**MUST NOT**：每条 memory 的标题/正文被无条件打进生产日志。

Fathom history is a separate, bounded event projection of successful authoritative
Recall. It stores only character scope, source channel, time, direct ids, Association
endpoint ids and relation labels, plus aggregate counts. Reads re-check current
visibility. This does not add telemetry fields to `MemoryRecord`, change Recall
selection, or persist user text.

**FUTURE CONTRACT（durable recall telemetry 的前置条件）**：

> 未来如果**任何** recall telemetry 被提升为 durable `MemoryRecord` 字段，
> **必须**先把它加入 **telemetry exclusion**
> （即 `assets/js/memory-contract.js` 的 `TELEMETRY_FIELDS`），
> 并**证明** `contentFingerprint` / migration idempotency 不受影响。

**理由**：`contentFingerprint` 是"两条记录是不是同一条"的唯一判据；
migration 的幂等性建立在"内容相同 ⇒ skipped"之上。一个每轮都变化的字段
若进入 fingerprint，重跑迁移会把**全部**记录判为 `updated`，
幂等性立刻失效。反过来，若为了回避该问题而把 fingerprint 关掉，
则"内容真的变了"不再能被发现。两条路都不可接受，
因此唯一正确的做法是 **先排除、再引入**。

---

## 14. Known Parallel Recall Pipeline: Auto Memory

### 14.1 如实登记

`Auto Memory` 是一条**独立于 canonical memory recall 的并行召回管线**：

| 维度 | canonical memory recall | Auto Memory |
|---|---|---|
| 存储 | Home Node `memory_records`（canonical）+ IndexedDB mirror | 独立 store `autoMemory` |
| 注入 | 本 contract 的 orchestration | **自有注入块** |
| ACL | `memory-visibility-core.js`（fail closed） | **不共享 canonical ACL** |
| Scoring | canonical scoring | **自有打分** |
| Home Node / Android 消费 | 是 | **否**（不消费这条路径） |

### 14.2 定位（MUST）

**MUST**：Auto Memory **不得**被描述为 canonical Memory 的 producer。
它是在 canonical 记忆系统之外并行存在的**第二条 recall 管线**。

**MUST NOT**：在文档或代码注释中把 Auto Memory 的写入/注入
表述为"经 canonical memory 落库"或"canonical memory 的一部分"。

### 14.3 本轮处置

**本轮不修、不合并、不改动。**
"是否未来合并"是**未决的产品 / 架构问题**，
**不属于 P21-R2-A**，也**不属于** R2-B ~ R2-F。

---

## 15. Known Authority Gap: MEMORY-ACTIVATION-AUTHORITY

### 15.1 现状（如实记录）

| 事实 | 位置 |
|---|---|
| 桌面 `recordMemoryActivation` 经 `dbUpdate` 只更新 **mirror** | [`assets/js/memory.js`](../../../assets/js/memory.js)（选择后的强化阶段）+ [`assets/js/core.js`](../../../assets/js/core.js) 的原始 IndexedDB 事务 |
| `memoryAuthority.recordActivation` **已存在**（镜像先落 + 远端 activate，`revisionTouched:false`） | [`assets/js/memory-authority.js`](../../../assets/js/memory-authority.js) |
| 上述 authority 通道**没有生产调用点** | 仅测试引用 |
| hydration 会**覆盖** mirror 的 activation telemetry | [`assets/js/core.js`](../../../assets/js/core.js) 的 mirror 整表重建 + Home Node 从 promoted 列回填 |

### 15.2 后果（推断，未经运行时观测）

- 桌面累计的 `activationCount` **不进入** canonical；
- 每次 hydration 之后，mirror 的 activation 计数被 canonical 值覆盖；
- 因此"回忆习惯"在桌面上的实际效果**弱于**文档描述。

### 15.3 本轮处置

**MUST NOT**：**R2-A 时点**的处置是**不接线**、**不改 endpoint**、**不改 schema**、**不改 Home Node**。

**登记为**：`Known Authority Gap: MEMORY-ACTIVATION-AUTHORITY`

**指向未来**：**R2-H · Authority Closure**。

> ### 15.3.1 状态更新（R2-H1 冻结 → R2-H2 实现 → R2-H3 语义收口 → **R2-H4 收口**）
>
> ```
> AUTHORITY FROZEN IN R2-H1
> IMPLEMENTED IN R2-H2
> RETRY/IDEMPOTENCY SEMANTICS FROZEN IN R2-H3
> R2-H ACTIVATION AUTHORITY = CLOSED（R2-H4）
> ```
>
> - **已冻结**：在 canonical mode 下，**Home Node 是 activation telemetry 的唯一 canonical
>   durable authority**；browser 的 `activationCount` / `lastActivated` 是 **mirror / cache**；
>   canonical activation 写入必须 **remote-first**；失败时 **canonical 与 mirror 都不增加**
>   （telemetry fail-closed），而 **turn 结果保持 fail-open**。
>   规范文本见 [`MEMORY_AUTHORITY_CONTRACT.md`](MEMORY_AUTHORITY_CONTRACT.md) §2.1–§2.5，
>   同步面语义见 [`MEMORY_SYNC_CONTRACT.md`](MEMORY_SYNC_CONTRACT.md) §3.1。
> - **已实现（R2-H2）**：生产 browser 强化路径（`assets/js/memory.js` 的
>   `recordMemoryActivation`）在 canonical mode 下**已经**经 `memoryAuthority.recordActivation`
>   走 canonical activation authority（remote-first）；`memoryAuthority.recordActivation`
>   现在是**生产 live seam**（不再是死缝）。canonical 成功后 mirror 用服务端返回的
>   **权威 per-id telemetry** SET（不是按 delta 猜测）；拿不到权威值时保持 stale。
>   本节 15.1 的四条事实描述的是 **R2-H0/R2-H1 时点的现状**，已由 R2-H2 关闭。
> - **仍然成立的红线**：R2-H1/H2 没有把 activation 塞进 `memory_change_log`、
>   没有推动 revision、没有引入 durable cooldown 字段，也没有引入队列/自动重试/幂等键
>   （后者归 R2-H3）。
> - **R2-H3 冻结（retry / idempotency）**：activation endpoint 是
>   **NON-IDEMPOTENT MUTATION**，`AUTO_RETRY = NONE`；`DEFINITE_FAILURE`（服务端明确回失败）
>   ⇒ canonical 与 mirror 都不增加；`AMBIGUOUS_OUTCOME`（transport 失败，服务端可能已 commit）
>   ⇒ canonical 状态对 caller **未知**，mirror 不猜测、不自动重试，等下一次 hydrate 纠正。
>   规范文本见 [`MEMORY_AUTHORITY_CONTRACT.md`](MEMORY_AUTHORITY_CONTRACT.md) §2.3 / §2.6。

**与 cooldown 的关系**：这也是 cooldown 在 R2 阶段采用
**session-local**（§10）的直接原因 —— 一个依赖跨端持久遥测的冷却机制，
在 authority 缺口未关闭前会**周期性静默失效**，
而静默失效的冷却比没有冷却更糟。

---

## 16. Non-goals

本 contract **不**固定：

- relevance 的具体公式与证据分值；
- channel 的数值阈值、席位条数、冷却时长、预算百分比；
- seat / exploration 的具体算法；
- trace 的输出 sink 与 UI；
- storage schema、promoted columns、`DB_VER`；
- `MemoryValueV2` 的具体参数。

本 contract **不引入**：

- vector DB / embedding / 向量检索；
- RAG framework；
- BM25（作为候选升级方向时，必须先取真实分布证据，
  并回答"解决哪一个可复现问题"）；
- 任何新依赖。

**MUST**：原生 memory 召回**保持 lexical / 可解释**。
外部 RAG / 向量工具可经 MCP 作为**工具通道**接入，
但那**不是** IB 记忆系统本体。

---

## 17. Enforcement

| Concern | 测试 |
|---|---|
| 本 contract 的文本与词表冻结 | `tests/test_memory_recall_contract.js` |
| Visibility pre-filter（SAFE_PRE_FILTER） | `tests/test_memory_contract_closure.js`（T6）、`tests/test_p11_2i_integrity_closure.js`（B19） |
| 唯一 ACL / fail closed | `tests/test_memory_contract_closure.js`、`tests/test_mobile_memory_read_boundary.js` |
| 既有 reason 词表 | `tests/test_p11_2i_integrity_closure.js` |
| 两端召回一致（parity） | `tests/test_memory_migration.js`（T5）、`tests/test_mobile_memory_continuity.js`（T3.8） |
| Record contract / telemetry exclusion | `tests/test_memory_contract_closure.js` |
| Migration 幂等性 | `tests/test_memory_migration.js` |
| Production memory runtime 未被**本阶段（R2-A）**改动 | `tests/test_memory_recall_contract.js`（生产文件 hash 断言，见该测试说明） |

> **历史语境（不得读成当前状态）**：上表最后一行是 **R2-A 时点**的陈述。P21-R2-F1b（closure
> commit `2e6f7e9`）**确实修改了**生产 memory runtime 并显式迁移了 hash pin（见该 fixture 的
> `note`）。该行保留为 chronology，不代表当前 truth。

**P21-R2-F1b implementation enforcement（R2-G1 补录）**

| Concern | 测试 / authority |
|---|---|
| session-local cooldown 行为 authority | [`MEMORY_COOLDOWN_CONTRACT.md`](MEMORY_COOLDOWN_CONTRACT.md)（其 §26 是完整映射） |
| session state（计数 / 幂等 / 隔离 / restart） | `tests/test_memory_recall_session_state.js` |
| factor 曲线与不变量 | `tests/test_memory_recall_cooldown.js` |
| F1b 冻结行为用例 | `tests/test_memory_recall_r2f_cooldown_baseline.js`、`tests/test_memory_recall_r2f_cooldown_delta.js` |
| browser / Home Node lifecycle 与行为闭合 | `tests/test_memory_recall_cooldown_hosts.js` |
| 两端状态分离 | `tests/test_memory_recall_two_host_parity.js` |

> **Mapping ≠ registry membership**：上面两张表都只表达**语义归属**。一个测试被本表点名
> **不等于**它已经进入 `tests/test-all.js` 的 aggregate registry，也**不等于**它当前 green。
> registry 成员资格与运行结果以 `tests/test-all.js` 和 aggregate 结果为准（R2-G0/G2）。

**本 contract 在 R2-A 时点的执行方式**：契约文本以 **static assertion**
钉住（文件存在、词表完整、声明齐全），接口形状以 **fixture / 形状断言**
钉住。**尚未有生产实现的条款不要求生产行为已改变。**
（R2-A 之后：R2-B ~ R2-F1b 已实现；仍未实现的条款见各节的 FUTURE CONTRACT 标注。）

---

## 18. Historical References

- [`../architecture/MEMORY.md`](../../architecture/MEMORY.md) — 当前 Memory 架构（canonical）
- [`MEMORY_COOLDOWN_CONTRACT.md`](MEMORY_COOLDOWN_CONTRACT.md) — **当前有效的 runtime cooldown 行为契约**（session-local；状态 implemented，implementation anchor = P21-R2-F1b closure commit `2e6f7e9`）。与本文档是**并列**的 authority：本文档冻结 recall 行为，它冻结 cooldown 行为
- [`MEMORY_AUTHORITY_CONTRACT.md`](MEMORY_AUTHORITY_CONTRACT.md) — storage authority
- [`MEMORY_RECORD_CONTRACT.md`](MEMORY_RECORD_CONTRACT.md) — record 形状与 telemetry exclusion
- [`../../MEMORY.md`](../../MEMORY.md) — retrieval/scoring 叙述（pre-authority model）
- [`../../DECISIONS.md`](../../DECISIONS.md) — D14/D15（未引入向量库）与本轮新增的 P21-R2 decision
