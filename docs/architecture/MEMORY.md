# Memory 架构

**Status: Canonical**
**Scope: 当前 Memory 架构**

> InternalBeyond Memory 子系统的当前状态描述：memory 如何被存储、检索、评分、admitted、
> consolidated，以及谁拥有它。它不是 migration report、phase report 或 audit。
> Source-of-truth 优先级：生产代码 → enforcement tests → 当前 contracts → audit → history。
>
> **Recall 的语义契约见 [`../contracts/memory/MEMORY_RECALL_CONTRACT.md`](../contracts/memory/MEMORY_RECALL_CONTRACT.md)**
> （P21-R2-A 冻结）；cooldown 的行为契约见
> [`../contracts/memory/MEMORY_COOLDOWN_CONTRACT.md`](../contracts/memory/MEMORY_COOLDOWN_CONTRACT.md)
> （已实现，anchor = P21-R2-F1b closure commit `2e6f7e9`）。
> 本文档描述**当前**架构。两份 contract 里标注 FUTURE CONTRACT 的条款，指的是
> **R2-A 时点**尚无生产实现的部分；**R2-B ~ R2-F1b 现已实现并提交**，仍未实现的只有
> `reminisce`、durable cooldown、`MemoryValueV2`，以及 §8.2 登记的 activation authority
> 缺口（R2-H）。

---

## 1. 目的

Memory 是 IB 为角色提供的持久、可解释的长期 memory：一组结构化 records，会被评分、排序并有选择地
注入 model context，外加一个决定什么值得记住的 consolidation/admission 层。它刻意采用
**text-scored retrieval，而非 vector store**（见 `DECISIONS.md` D14/D15）。

Memory **不是**：model executor、Middle Brain component、Android feature 或 provider cache。

---

## 2. Runtime 位置

| 模块 | 层 | 职责 |
| --- | --- | --- |
| `services/home-node/memory-store.js` | Node / Home Node | canonical durable storage（`memory_records`）、revision、idempotency、migration watermark |
| `services/home-node/memory-retrieval.js` | Node / Home Node | Home Node execution path 的 canonical retrieval rendering |
| `assets/js/memory-contract.js` | shared UMD | record contract：content vs telemetry、fingerprint、`owner_id`、structural validation |
| `assets/js/memory-retrieval-core.js` | shared UMD | **唯一**的 scoring / relevance / ranking / budget / rendering 实现 |
| `assets/js/memory-authority.js` | Browser | authority/mirror/fallback policy（canonical / mirror / off） |
| `assets/js/memory-visibility-core.js` | shared UMD | visibility/ACL predicate（C1 fail-closed） |
| `assets/js/memory.js` | Browser | UI + producers（`quickCreateMemory`）+ consolidate + export/import |
| `assets/js/memory/auto-memory.js` | Browser | AI 驱动的 memory creation/update + admission |

Authority model 详情见 [`../contracts/memory/MEMORY_AUTHORITY_CONTRACT.md`](../contracts/memory/MEMORY_AUTHORITY_CONTRACT.md)。

---

## 3. Storage 边界

```
                       canonical
                    Home Node memory_records
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
   Browser IndexedDB memories        Mobile: (none)
   mirror / migration source /
   rollback shadow
```

- **Home Node owns durable Memory state。** 共享 `home-node.db` 中的 `memory_records`（+
  `memory_change_log`、`meta['memory_schema']`、`meta['memory_revision']`）。
- **Browser IndexedDB 是一个 mirror。** 它是 migration source 与 rollback shadow；它永远不是
  durable authority。（`assets/js/core.js` store `memories`；authority model 见 `HOME_NODE_CHAT.md §15`。）
- **Mobile 没有 Memory authority。** 设备上既无 memory verb 也无 memory cache。

Home Node **owns**：records、revision、schema、idempotency。
Home Node **does not own**：UI rendering、client scoring、consolidation decisions——这些属于 browser-side。

---

## 4. Memory Lifecycle

| Operation | Owner | Storage | API | Consumer |
| --- | --- | --- | --- | --- |
| Create | browser constructors（`quickCreateMemory` 与 producers）→ authority | Home Node（随后 mirror） | `POST /memory/records` | chat / diary / moments / letters / activity |
| Store | **Home Node** | `memory_records` | — | — |
| Read | Memory subsystem（shared retrieval core） | 用于 UI 的 canonical / mirror | `GET /memory/list`, `GET /memory/changes` | chat / UI / Middle Brain |
| Update | Memory authority（Home Node overwrite） | canonical + change_log | `POST /memory/records` | 用户编辑 / consolidation |
| Activate | Home Node（仅 promoted columns） | canonical | `POST /memory/activate` | retrieval |
| Sync | Home Node → browser mirror | mirror | `/memory/list`, `/memory/changes` | bootstrap |
| Export / Import | Browser | mirror JSON | (local) | 用户备份 |
| Migration | client bootstrap + Home Node watermark | canonical | `/memory/migration`, `/memory/migrate` | 一次性 |
| Consolidation | Browser | via authority | — | runtime |
| Delete | Home Node soft delete | canonical + mirror | `POST /memory/records` | 用户 / runtime |

能够 **read** memory 并不意味着拥有 lifecycle ownership。Durable lifecycle 由
Memory subsystem（Home Node）拥有。

---

## 5. Retrieval 架构

`assets/js/memory-retrieval-core.js` 是 scoring、relevance、ranking、
budget 与 line rendering 的唯一实现；browser（`memory.js`）与 Home Node
（`services/home-node/memory-retrieval.js`）都委托给它。

排序（未变，不可协商）：

```
candidate set → visibility/ACL → relevance → ranking → top-k / budget → rendered context
```

- **Scoring**（`getMemoryScore`）：`importance × activationFactor × decayFactor × emotionFactor`；
  `pinned` → 999。Activation 在 canonical revision stream 之外跟踪。
- **Visibility/ACL**：`memory-visibility-core.js`，fail-closed（缺失/格式错误的 `visibility` 会被
  保留并解析为 not-visible，绝不会解析为 public）。
- **Budget**：有界注入；retrieval 不随 memory library 增长。

### 5.1 Lexical / 非向量（如实声明）

原生 recall 是**可解释的文本评分**：中文 2–3 字 n-gram + 英文词做相关性，
配合上面的手写四因子打分。**没有** embedding、向量库、相似度检索或 RAG framework。
（`DECISIONS.md` D14/D15 明确否决引入向量库。）

用户可在 DIY → MCP 挂载外部 RAG / 向量工具，那会以 `mcp.<alias>.<tool>` 暴露为**工具通道**，
**不是** Memory Runtime 本体，也不参与本节这条 recall 链。

### 5.2 Recall Orchestration（P21-R2-A 冻结契约 · **R2-B ~ R2-F1b 已实现**）

召回**不再**是"一次 `buildMemoryContext()` 决定一切"的单管线：turn 决策（early exit、
channel 仲裁）、query 构造、visibility pre-filter、hard gate 与 trace 组装由
`assets/js/memory-recall/memory-recall-orchestrator.js` 承担；排序 / 打分 / 预算 / 渲染仍由
**唯一** selector `assets/js/memory-retrieval-core.js` 承担；browser 与 Home Node 共用这两层。

[`MEMORY_RECALL_CONTRACT.md`](../contracts/memory/MEMORY_RECALL_CONTRACT.md) 冻结的
**Memory Recall Orchestration** 边界，逐条现状：

- **channel 词表**：`legacy`（兼容旧调用 / 未提供 turn signal 的路径）· `surface` ·
  `recall` · `glossary` · `coldStart` —— **已实现**（策略真源
  `assets/js/memory-recall/channel-policy.js`）；`reminisce` 仍为 **future**。
- **`relevanceScore` 与 `memoryValue` 分离** —— **已实现**（gate 只看 relevance）；
  `MemoryValueV2` 仍是 **future**（契约 §7.3）。
- **hard gate**：`0 memory is a valid successful recall result`，且
  `early-exit` / `gate-rejected` / `no-visible-memory` 三种"零结果"**可区分** —— **已实现**。
- **cooldown 先 session-local**（`RecallSessionState`，不落 `MemoryRecord`）—— **已实现**，
  作用于 browser 与 Home Node 的 canonical chat recall；行为 authority 是
  [`MEMORY_COOLDOWN_CONTRACT.md`](../contracts/memory/MEMORY_COOLDOWN_CONTRACT.md)
  （implementation anchor = P21-R2-F1b closure commit `2e6f7e9`）。
  **durable** cooldown 仍是 **future**（契约 §10.2）。
- **`RecallTrace`** 可解释、可断言、禁止正文与凭据 —— **已实现**。

**chronology（不得读成当前状态）**：上述条款在 **R2-A 时点**都还不是当前行为 ——
当时 `calcRelevance()` 下限恒为 `1`、无法表达"没有任何相关证据"，预算曾是唯一的停止条件，
也不存在任何 channel / cooldown 实现。**R2-B、R2-C、R2-D、R2-E1a/E1b、R2-F1a、R2-F1b
现已全部实现并提交。** 仍未实现的只有：`reminisce`、durable cooldown、`MemoryValueV2`，
以及 §8.2 登记的 activation authority 缺口（**R2-H**）。

---

## 6. Admission

Admission（P11-2J）是**候选级写入准入**：`_calibrateMemoryCandidate`
（`assets/js/memory/auto-memory.js` → `assets/js/understanding-derivation-core.js`）
判断一个 memory **候选**是否值得被写进长期记忆，并给出稳定的拒绝原因。
它属于 browser-side 的写入路径，不拥有 storage。

**它不是 turn 级门。** 决定"某个 turn 是否执行 memory 副作用"的是
Middle Brain 的 side-effect gate（`_mbSideEffectGate`），且它只在回复中
**确实解析出 `<mem_*>` 操作**时被调用。

见 `tests/test_p11_2j_memory_admission.js`。

---

## 7. Consolidation

Consolidation 是一个 **browser-side** 过程（`assets/js/memory/auto-memory.js`、`memory.js`）。

Consolidation **owns**：summarize、merge、deduplicate、score、provenance（`consolidatedFrom`、
`lastConsolidatedAt`）。
Consolidation **does not own**：durable storage、sync、lifecycle、retrieval authority。

> **Consolidation ≠ Storage Authority。** Consolidation 通过同一条 authority path
> 写入（`quickCreateMemory` → authority）。`lastConsolidatedAt` 是 watermark，而非 content。

### 7.1 Store 边界与术语（R2-G）

| 术语 | 指什么 | durable authority？ |
| --- | --- | --- |
| **canonical memory** | Home Node `memory_records` 中的记录（canonical recall 的唯一输入面） | **是**（唯一） |
| **canonical durable authority** | Home Node storage（`memory-store.js`）及其写入路径 | **是** |
| **browser mirror** | IndexedDB `memories`，canonical 的镜像 | 否（hydration 会整表重建） |
| **parallel store** | 与 canonical **并列**、不共享 canonical ACL、不参与 canonical recall 的独立持久域 | 否 |
| **consolidation** | browser-side 的 summarize / merge / dedupe / provenance 过程（§7） | 否（经 canonical 写入路径落库） |
| **Auto Memory** | 独立 store `autoMemory` + 自有打分/注入的并行召回管线（§8.1） | 否 |
| **roleLetterMemories** | 角色私信的独立命名空间（`owner=characterId`），绝不写共享 `memories` | 否 |

> **R2-G does not unify these stores.** 本轮**没有**把 Auto Memory、`roleLetterMemories`
> 或任何其它 parallel store 并入 canonical memory，也没有改动它们的 ACL / scoring / 注入。
> `docs/MEMORY.md` §6 的"长期记忆来源"表说的是**各来源的写入路径**，
> **不等于**"全部进入 canonical memory" —— 只有走 canonical 路径的那些会进入 `memory_records`。

---

## 8. Consumer 矩阵

| Consumer | Read | Write | Authority |
| --- | --- | --- | --- |
| Chat | 是（`getMemoryContext`） | 是（`quickCreateMemory`） | consumer |
| Group Chat | 仅 public 的 memory | 经由 group memory policy | consumer |
| Role DM | role-scoped visibility | 是（`quickCreateMemory`，`source:'role_dm'`，`visibility:'only'`） | consumer |
| Diary | — | `source:'diary'`（importance ≥ 6、similarity < 0.8） | consumer |
| Moments | moments context | **否**（不写 memory record） | consumer |
| Letters | — | `roleLetterMemories`（独立 store，**不**写 `memories`） | consumer |
| Role Letters（私信记忆） | — | `roleLetterMemories`（独立 store，importance 6） | consumer |
| Middle Brain | 选定的 context，read + compress | **否** | read-only |
| Mobile | **否** | **否** | denied |

Consumer ≠ Owner。除 Memory subsystem 外，没有任何 consumer 拥有 durable memory state。

> **`roleLetterMemories` 是独立 store，不是 canonical memory。** 它不参与
> `memory_records`、不参与 canonical recall、不共享 canonical ACL。
> 历史上曾误入 `memories` 的 `source:'role_letter'` 行由一次性清理移除。
>
> **Auto Memory 不在本矩阵内** —— 它是一条并行的独立召回管线，见 §8.1。

### 8.1 Known Parallel Recall Pipeline: Auto Memory

`Auto Memory`（`assets/js/memory/auto-memory.js`）是一条**独立于 canonical memory
recall 的并行召回管线**：

| 维度 | canonical memory recall | Auto Memory |
| --- | --- | --- |
| 存储 | Home Node `memory_records`（canonical）+ IndexedDB mirror | 独立 store `autoMemory`（IndexedDB，按角色分区） |
| 注入 | `getMemoryContext` / recall orchestration | **自有注入块**（`amBuildInject`） |
| ACL | `memory-visibility-core.js`（fail-closed） | **不共享 canonical ACL** |
| Scoring | canonical scoring | **自有打分** |
| Home Node / Android 消费 | 是 | **否** |

**它不得被描述为 canonical Memory 的 producer 或 canonical Memory 的一部分。**
是否未来合并是一条**未决的产品 / 架构问题**，不属于 P21-R2。

---

### 8.2 Known Authority Gap: MEMORY-ACTIVATION-AUTHORITY

| 事实 | 位置 |
| --- | --- |
| 桌面 `recordMemoryActivation` 经 `window.dbUpdate` 更新 **mirror** | `assets/js/memory.js` 的强化阶段 + `assets/js/core.js` 的原始 IndexedDB 事务 |
| `memoryAuthority.recordActivation` **已存在**（镜像先落 + 远端 activate，不推进 revision） | `assets/js/memory-authority.js` |
| 上述 authority 通道**没有生产调用点** | 仅测试引用 |
| hydration 会**覆盖** mirror 的 activation telemetry | `assets/js/core.js` 的 mirror 整表重建 + 服务端从 promoted 列回填 |

**后果**：桌面累计的 `activationCount` 不进入 canonical；每次 hydration 后被 canonical 值覆盖。
因此"回忆习惯"在桌面上的实际效果**弱于**本文档 §5 公式给人的印象。

**状态：`R2-H ACTIVATION AUTHORITY = CLOSED`**（R2-H1 冻结语义 → R2-H2 接线 → R2-H3 retry/幂等语义 → R2-H4 收口）。
最终权威矩阵见 [`MEMORY_AUTHORITY_CONTRACT.md`](../contracts/memory/MEMORY_AUTHORITY_CONTRACT.md) **§2.7**（本节不重复维护第二张表）。

- **R2-H1 冻结**：canonical mode 下 **Home Node 是 activation telemetry 的唯一 canonical durable
  authority**；browser 的 `activationCount` / `lastActivated` 是 **mirror / cache**；
  canonical activation 写入 **remote-first**；失败时 canonical 与 mirror **都不增加**
  （telemetry fail-closed），而 **turn 结果保持 fail-open**。
  规范文本：[`MEMORY_AUTHORITY_CONTRACT.md`](../contracts/memory/MEMORY_AUTHORITY_CONTRACT.md) §2.1–§2.5
  · 同步面：[`MEMORY_SYNC_CONTRACT.md`](../contracts/memory/MEMORY_SYNC_CONTRACT.md) §3.1
  · 状态更新：[`MEMORY_RECALL_CONTRACT.md`](../contracts/memory/MEMORY_RECALL_CONTRACT.md) §15.3.1
- **R2-H2 已实现**：生产 browser 强化路径（`assets/js/memory.js`）在 canonical mode 下经
  `memoryAuthority.recordActivation` 走 canonical authority（remote-first）；
  `/memory/activate` 的响应**加法式**新增权威 per-id telemetry，mirror 据此 **SET** 成 canonical 值
  （不按 delta 猜测；拿不到权威值就保持 stale，等 hydrate 纠正）。
  上述 §8.2 表格记录的是 **R2-H0/H1 时点的现状**，已由 R2-H2 关闭。
- 这也解释了为什么 P21-R2 的 cooldown 先采用 **session-local**
  （`RecallSessionState`）—— 一个依赖跨端持久遥测的冷却机制在此缺口关闭前会周期性静默失效。
  相关：**durable cooldown 仍为 FUTURE**，与本 decision 无关。

### 8.3 R2-G 未做的事（non-goals）

P21-R2-G 是 **docs / tests / registry 的 consolidation**。以下每一项都**没有**在本轮发生
（不新增 phase 名称，只引用既有归属标签）：

| 未做 | 归属 |
| --- | --- |
| activation authority closure（§8.2 的缺口） | **R2-H** |
| browser mirror hydration authority closure（§12 的 hazard） | **R2-H** |
| durable cooldown（把 recall telemetry 提升为 durable 字段） | FUTURE（cooldown contract §10.2） |
| `MemoryValueV2` | FUTURE（recall contract §7.3） |
| Auto Memory 并入 canonical recall | **out-of-scope**（§8.1 的未决产品 / 架构问题） |
| `roleLetterMemories` 并入 canonical memory | **out-of-scope** |
| Presence 二次召回（`R2-E0-PARALLEL-RECALL-1`） | 未决（cooldown contract §22） |
| alias boundary closure（`R2-E1b-ALIAS-BOUNDARY-1`） | 未决 |

---

## 9. Middle Brain 边界

根据 [MIDDLE_BRAIN.md](MIDDLE_BRAIN.md)，Middle Brain **读取选定的 context 并压缩**它。
Memory subsystem 拥有 lifecycle。

- ❌ Middle Brain 不管理 memory。
- ❌ Middle Brain 不拥有 memory context。
- ✅ Middle Brain 读取 caller 提供的 memory context / snapshot，并返回压缩后的 context。

---

## 10. Chat / Diary / Moments 边界

Chat、Diary、Moments、Letters 与 Activity 是 **producers and consumers**，而非 owners。它们通过
共享 producer path 创建 memory，并通过共享 retrieval core 读取。它们各自的 stores
（`diary_entries`、`moments`、`roleLetterMemories`、`chatSummaries`、…）是独立的，**不会**
迁移到 Home Node memory authority（见 `HOME_NODE_CHAT.md §15`）。

---

## 11. Export 边界

Memory export/import surface 是 browser-side 的（`memory.js` `exportMemories` / `importMemoriesFile`），
并作用于 **browser mirror**。

> 当前 export 是 browser mirror export，**而非** canonical Home Node export。

不得将其描述为官方 memory backup 或 canonical archive。

---

## 12. Known Runtime Hazard

```
Known runtime hazard:
  hydrate() performs local.replaceAll(page.records). If the Home Node list
  response is empty or its payload fails to unwrap, the mirror can be
  authoritatively cleared. The retrieval core can then render an empty
  context even though canonical records exist.

Status:
  Documented, not fixed in this phase.
```

这一点记录自代码与 client 自身的注释（`assets/js/home-node-client.js`
`_unwrapMemoryEnvelope`），此处未修复。见 `MEMORY_SYNC_CONTRACT.md` §Hydration。

---

## 13. Non-goals

Memory 不拥有：model execution、provider selection、Middle Brain composition、Android/mobile
surfaces、provider prompt cache，或其他 browser stores 的 durable state（`understandings`、
`threads`、`chatSummaries`、`diary_entries`、`moments`、`posts`、`calEvents`、`activities`）。

---

## 14. Enforcement

| Concern | Tests |
| --- | --- |
| Record contract | `test_memory_contract_closure.js` |
| Authority / mirror / fail-closed | `test_memory_authority.js` |
| Migration + watermark | `test_memory_migration.js` |
| Home Node storage assembly | `test_home_node_production_memory_assembly.js` |
| Mobile read boundary | `test_mobile_memory_read_boundary.js`, `test_mobile_memory_continuity.js` |
| Admission / consolidation | `test_p11_2j_memory_admission.js`, `test_memory_consolidation.js` |
| Recall 契约（词表 / gate / trace / 生产文件完整性） | `test_memory_recall_contract.js` |

Runtime 行为由这些 tests 强制；本文档是人类 canonical authority。

---

## 15. Historical References

历史文档描述演进；它们不承载当前 authority。

- [`../contracts/memory/MEMORY_RECALL_CONTRACT.md`](../contracts/memory/MEMORY_RECALL_CONTRACT.md) — Recall orchestration 目标契约（P21-R2-A 冻结，含 FUTURE CONTRACT 条款）
- `docs/HOME_NODE_CHAT.md` §15 — M1-C.2d Wave 2 canonical memory authority（contract 起源）
- `docs/DECISIONS.md` — D12/D14/D15 与 storage-authority 对比，以及 P21-R2 decision
- `docs/MEMORY.md` — retrieval/scoring 叙述（pre-authority model）
- `docs/history/runtime/CONTEXT-CONVERGENCE-C1-REPORT.md`
- `docs/history/runtime/P2-CONTEXT-CONVERGENCE-AUDIT.md`
