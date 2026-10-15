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
> **Reconstructive Memory 的层边界契约**（canonical evidence / recollection /
> interpretation / metamemory / **expectation & prediction error** / counterfactual /
> behavior influence）见
> [`../contracts/memory/RECONSTRUCTIVE_MEMORY_CONTRACT.md`](../contracts/memory/RECONSTRUCTIVE_MEMORY_CONTRACT.md)
> （P21-R4-A / A.1 / A.2 / A.3 冻结；**runtime 生产实现 = NONE**，不得据此认为已生效。
> R4-A.2 / A.3 只修 **activation authority** 的旧 UI telemetry coupling 与 resolver
> ambiguity（唯一 production 文件 `assets/js/memory.js`），**不是** reconstructive
> runtime implementation，也**不**改变 Home Node 的 activation authority。）
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

## 16. P21-R3 Association

Association is a bounded, runtime-derived relation view after direct authoritative
Recall. It can expand cognition context and report support, complement, conflict,
correction, continuation, contextualize, and unrelated relations. It does not
change Recall selection, canonical Memory, activation, exposure, or relationship
state.

Candidate discovery scans at most 20,000 canonical rows with the shared Memory
visibility and ranking core, then caps its source set at 64. The relation
classifier receives at most 12 pairs in one call. The working set adds at most
four memories at depth one and preserves direct Recall activation provenance.
Association failures fall back to direct Recall. No durable relation graph is
introduced.

The canonical contract is
[MEMORY_ASSOCIATION_CONTRACT.md](../contracts/memory/MEMORY_ASSOCIATION_CONTRACT.md).
This P21-R3 runtime does not implement R4-G causal graph traversal.

## 17. P21-R4-K Contextual Reinterpretation

The existing MemoryInterpretation runtime now accepts an Association working
set through one internal seam. Direct Recall remains authoritative; direct
memories are prioritized within the eight-memory cap, and each associated
memory retains its activation reason and relation provenance. A validated,
runtime-only `currentMeaning` is added to the same Recall cognition context.

The topic comes from the current validated user message. Relationship context is
read from the character DTO configuration. Current emotion and a stable
cognitive snapshot are not available to this Home Node seam and are reported as
unavailable. A browser `IBContextSnapshot` exists for Middle Brain, but Recall's
closed request does not carry it. One contextual model call is capped at 1,200 ms
and 1,200 delivered characters; its output allowance uses half the configured
Recall budget. It runs behind the existing per-character auto-interpretation
policy. A failure leaves Recall and Association context
available. No Memory, relationship, emotion, BehaviorEffect, Prediction Error,
or Self Narrative write is owned by this phase.

The phase extends
[`RECONSTRUCTIVE_MEMORY_CONTRACT.md`](../contracts/memory/RECONSTRUCTIVE_MEMORY_CONTRACT.md)
and is covered by the three `test_memory_reinterpretation_*` suites.

## 18. P21-R4-L Self Narrative

Self Narrative is a revisionable, derived story about the character and the
relationship with the user. The only production call site is the post-R4-K
branch in Runtime Recall. It consumes the validated current meaning and the
already-filtered Association provenance; it does not query Memory again.

The narrative owner is `runtime-self-narrative.js`, with one pure core for its
closed schema and evidence envelope. Claims carry Memory refs plus the R4-K
interpretation ref and relevant Association relation/tension refs. The schema
requires themes and current beliefs, so an event-only summary cannot pass.

Narrative revisions live in a bounded per-character/per-conversation in-memory
session map (64 sessions, 30-minute TTL, up to 32 retained versions per live
session). The existing R4-K per-character policy gates its single model call;
no new cost bit or persistent store is introduced. Failure serves the previous
session narrative when available, otherwise no narrative, while Recall,
Association, Reinterpretation, and chat continue. No canonical Memory,
relationship, persona, behavior, Prediction Error, or shared-memory writer is
called by this phase. After a failed or timed-out provider call, the same
evidence fingerprint is suppressed for five minutes; changed evidence may
start a new refresh.

The canonical contract is
[`RECONSTRUCTIVE_MEMORY_CONTRACT.md`](../contracts/memory/RECONSTRUCTIVE_MEMORY_CONTRACT.md)
q-50. Deterministic fake-provider coverage is registered in the three
`test_self_narrative_*` suites.

## 19. P21-R4-M0 · Response Guidance and External Participation

M0 adds a shared `response-guidance-v1` envelope consumed by both the Desktop
message assembler and the Home Node Mobile execution prompt. The existing R4-F
BehaviorEffect remains its own source entry and keeps its seven-key schema and
fixed renderer. External participation is a separate record inside the one
`runtime-behavior-effect.js` attribution owner; it never carries a posture or
creates a synthetic BehaviorEffect.

The Mobile executor marks external participation consumed only after the
server has validated and inserted it in the prompt sent to the model port.
Unaccounted participation makes attribution `unknown/partial`, not
`known-none`. The Desktop provider call still happens in the browser, so the
Home Node cannot verify prompt consumption there. M0 is partial, no Memory
Behavior Modulation producer or schema exists, and R4-M remains blocked until a
trusted Desktop consumption receipt or server-owned response execution path is
available.

The append-only contracts are q-51 in
[`RECONSTRUCTIVE_MEMORY_CONTRACT.md`](../contracts/memory/RECONSTRUCTIVE_MEMORY_CONTRACT.md)
and I.29 in
[`PREDICTION_ERROR_AUTHORITY_CONTRACT.md`](../contracts/memory/PREDICTION_ERROR_AUTHORITY_CONTRACT.md).

## 20. P21-R4-M0-R2 · Desktop fail-closed admission audit

The owner accepted Option B and deferred trusted Desktop provider execution.
Desktop external participation without a trusted receipt stays
`unknown/partial`; the Mobile execution consumer remains runtime-verifiable.
An isolated P3/P4 probe found that this attribution fact is not sufficient for
calibration exclusion in every case: a Prediction created as `known-none`
before registration can combine a later UNKNOWN observation with an earlier
clean decisive support observation, settle as `matched`, and pass
`calibrationCounted=true` through the existing P4 driver.

No production P.E. code changed in R2. The registered clean-sample guard records
this counterexample and currently fails, so R2 does not unlock R4-M. Resolving
the gap requires an authorized P3/P4 semantic decision; R2 must not add a
Desktop-specific calibration bypass or declare Option B safe prematurely.

```text
DESKTOP_CONSUMPTION_RUNTIME_VERIFIABLE = NO
DESKTOP_ATTRIBUTION_FAIL_CLOSED = LIVE
UNVERIFIED_EXTERNAL_INFLUENCE_CLEAN_CALIBRATION = POSSIBLE
P21_R4_M0_R2_STATUS = BLOCKED
P21_R4_M0_STATUS = PARTIAL
R4_M_REENTRY = STILL_BLOCKED
TRUSTED_DESKTOP_EXECUTION_CONVERGENCE = DEFERRED_PLATFORM_WORK
```

## 21. P5-B3-J-R3 · Outcome-Time Calibration Evidence Basis

The P3 `calibrationCounted` decision now uses a deterministic basis of the
decisive P1 observations that support `matched` or `missed`. P1 already binds
outcome-time attribution to the RealityEvent timestamp and Prediction turn;
P3 consumes the sealed contamination class without another attribution query.

An independent clean decisive support can remain a valid matched basis when
later UNKNOWN supporting evidence is non-basis. Required decisive evidence
that is UNKNOWN or system-influenced keeps calibration ineligible while P3
still records its settlement. The existing Prediction-creation
self-influence veto remains. The P4 driver and ledger are unchanged and consume
only P3's sealed `calibrationCounted` bit.

The corrective tests cover clean/unknown mixed evidence, UNKNOWN-only evidence,
system-influenced decisive support and conflict, opportunity-gated missed
settlement, irrelevant evidence, replay, and P4 ingest/skip. This closes the
calibration gap for outcome-relevant decisive evidence. P21-R4-M0-R2 still
requires its own closure reconciliation before R4-M re-entry.

## 22. P21-R4-M0-R2 · Fail-Closed Desktop Admission Closure

Option B is accepted. Desktop provider dispatch remains browser-owned and
consumption remains unverifiable. Admission is safe after P5-B3-J-R3 because
unverified influence remains `unknown/partial`, while P3 ties calibration to
the outcome-time decisive basis. P4 continues to ingest only sealed P3
eligibility. Independent clean evidence remains eligible when later UNKNOWN
supporting evidence is non-basis.

```text
DESKTOP_CONSUMPTION_RUNTIME_VERIFIABLE = NO
R4_M_DESKTOP_ADMISSION_POLICY = FAIL_CLOSED_UNVERIFIED_ALLOWED
UNVERIFIED_EXTERNAL_INFLUENCE_CLEAN_CALIBRATION = IMPOSSIBLE_FOR_REQUIRED_DECISIVE_EVIDENCE
P21_R4_M0_R2_STATUS = COMPLETE
P21_R4_M0_STATUS = COMPLETE
P21_R4_M0_FREEZE = FROZEN
R4_M_REENTRY = ALLOWED
TRUSTED_DESKTOP_EXECUTION_CONVERGENCE = DEFERRED_PLATFORM_WORK
MEMORY_BEHAVIOR_MODULATION_IMPLEMENTED = NO
```

## 23. P21-R4-M · Memory-Driven Behavior Modulation

R4-M consumes only successful R4-K current meaning, the matching R4-L
self-narrative revision, and their Association provenance. Its output is a
five-axis `behavior-posture-v1` object with closed ordinal values. The temporary
posture is carried as `memory-behavior-posture-v1` inside the existing
`response-guidance-v1` envelope and rendered by that contract's fixed renderer.
It does not carry Memory bodies or narrative text and cannot force disclosure.

The Mobile path passes the candidate snapshot already read by the current Recall
into the existing Association → K → L stages. The posture producer consumes
those validated outputs; it does not retrieve Memories or repeat Association.
One bounded posture call is allowed per evidence/context fingerprint, with a
session-only replay cache. Failure, invalid output, missing evidence, or timeout
returns baseline and the chat continues. The posture has no writer into Memory,
relationship, persona, emotion, Self Narrative, Prediction Error, or message
schedule state.

Mobile records `CONSUMED` only after the shared envelope is validated, rendered,
and handed to the model port. Desktop renders the same posture through the
shared renderer; since provider execution stays browser-owned, attribution stays
`unknown/partial` and P3's decisive outcome-time gate excludes required unknown
influence from clean calibration.

```text
MEMORY_BEHAVIOR_MODULATION_RUNTIME = LIVE
MEMORY_TO_BEHAVIOR_CAUSALITY = LIVE
REINTERPRETATION_TO_BEHAVIOR = LIVE
SELF_NARRATIVE_TO_BEHAVIOR = LIVE
BEHAVIOR_POSTURE_IS_DERIVED = YES
BEHAVIOR_POSTURE_IS_TEMPORARY = YES
BEHAVIOR_POSTURE_IS_TURN_SCOPED = YES
BEHAVIOR_POSTURE_IS_BOUNDED = YES
MEMORY_CAN_INFLUENCE_BEHAVIOR_WITHOUT_FORCED_DISCLOSURE = VERIFIED
PERSONA_BASELINE_PRESERVED = YES
FAILURE_FALLBACK_TO_BASELINE = LIVE
CANONICAL_MEMORY_MUTATION = 0
RELATIONSHIP_MUTATION = 0
PERSONA_MUTATION = 0
EMOTIONAL_STATE_MUTATION = 0
SELF_NARRATIVE_MUTATION = 0
PREDICTION_ERROR_MUTATION = 0
ACTIVE_MESSAGE_SCHEDULE_MUTATION = 0
P21_R4_M_STATUS = COMPLETE
P21_R4_M_FREEZE = FROZEN
```

The append-only contract is q-55 in
[`RECONSTRUCTIVE_MEMORY_CONTRACT.md`](../contracts/memory/RECONSTRUCTIVE_MEMORY_CONTRACT.md).

## 24. P21-R4-H · Semantic Forgetting

R4-H is a runtime-only projection inside the shared Recall core. It distinguishes
factual detail, emotional residue, and narrative meaning with the closed states
`accessible`, `faded`, `suppressed`, and `latent`. The dimension-specific day
bands use existing `created`, `lastActivated`, `resolved`, `kind`, `summary` /
`oneLine`, `valence`, and `arousal`; no durable forgetting field is introduced.
`lastConsolidatedAt` remains a consolidation watermark, not a forgetting age
anchor. The `getMemoryScore()` calculation remains unchanged.

Visibility remains the first Recall gate. The ordinal accessibility band affects
ranking before the existing score tie-break. Detail projection reads a stored
summary or one-line view when factual details fade, and otherwise shortens the
rendered content. These are new per-turn views only. Pinned or strongly relevant
records can resurface, and existing selection activation can improve later
accessibility without restoring factual-detail availability.

Malformed forgetting input disables the projection for the entire Recall
candidate set and uses the prior ranking and rendering. Faded, suppressed, and
latent entries remain canonical and eligible for later resurfacing. The frozen
R2-F coldStart anchor fixture remains unchanged.

```text
SEMANTIC_FORGETTING_RUNTIME = LIVE
FACTUAL_DETAIL_DECAY = LIVE
EMOTIONAL_RESIDUE_DECAY = LIVE
NARRATIVE_MEANING_DECAY = LIVE
FORGETTING_AFFECTS_RECALL_ACCESSIBILITY = YES
FORGETTING_IS_NOT_DELETION = VERIFIED
RESURFACING = LIVE
FAILURE_FALLBACK_TO_NORMAL_RECALL = LIVE
CANONICAL_MEMORY_DELETES_FROM_FORGETTING = 0
CANONICAL_MEMORY_TEXT_REWRITES_FROM_FORGETTING = 0
P21_R4_H_STATUS = COMPLETE
P21_R4_H_FREEZE = FROZEN
```

The append-only contract is q-56 in
[`RECONSTRUCTIVE_MEMORY_CONTRACT.md`](../contracts/memory/RECONSTRUCTIVE_MEMORY_CONTRACT.md).

## 25. P21-R4-N · Meta-Memory Awareness & Uncertainty

R4-N derives a bounded, turn-scoped awareness object from the final selected
Recall ids and their already-computed R4-H projections, plus validated R4-K
meaning and R4-L narrative provenance. Its closed ordinal statuses are
`remembered`, `partial`, `uncertain`, `faded`, `interpretation_only`, and
`unavailable`. Factual detail, emotional residue, and narrative meaning keep
their separate H-derived availability. K/L claims carry source ids and
interpretation refs; current meaning is marked as derived and never promoted
to historical fact.

The only producer seam is `runtime-recall.js#runCurrentMeaningAndNarrative`,
after R4-L. Desktop appends its short internal reminder to the same private
cognition context. Mobile passes that same text through
`runtimeContextParts.memoryAwarenessContext`; the existing execution composer
places it after evidence and before current time. The reminder contains no
Memory body or debug status label, and it says not to fill missing wording or
bring up a memory solely because the reminder exists.

R4-N does not scan Memory, call a provider, or store awareness. Any invalid or
failed derivation is omitted; Recall and any successful K/L context remain
usable. It cannot write Memory, change H state, or mutate relationship,
persona, Self Narrative, behavior modulation, or Prediction Error.

```text
META_MEMORY_RUNTIME = LIVE
MEMORY_STATE_AWARENESS = LIVE
FORGETTING_AWARENESS = LIVE
INTERPRETATION_VS_FACT_AWARENESS = LIVE
UNCERTAINTY_AWARENESS = LIVE
META_MEMORY_IS_DERIVED = YES
META_MEMORY_DOES_NOT_REWRITE_MEMORY = VERIFIED
FAILURE_FALLBACK = LIVE
CANONICAL_MEMORY_MUTATION = 0
SEMANTIC_FORGETTING_MUTATION = 0
RELATIONSHIP_MUTATION = 0
PERSONA_MUTATION = 0
SELF_NARRATIVE_MUTATION = 0
BEHAVIOR_MODULATION_MUTATION = 0
PREDICTION_ERROR_MUTATION = 0
P21_R4_N_STATUS = COMPLETE
P21_R4_N_FREEZE = FROZEN
```

The append-only contract is q-57 in
[`RECONSTRUCTIVE_MEMORY_CONTRACT.md`](../contracts/memory/RECONSTRUCTIVE_MEMORY_CONTRACT.md).

## 26. P21-R4-O · Memory Unreliability

R4-O produces a private, turn-scoped `reconstructed-recollection-v1` object
from current R4-H availability, R4-N state awareness, validated R3 relation
edges and selected-row provenance, plus R4-K/L claims and references. Its
closed distortion vocabulary is `none`, `omission`, `temporal_blur`,
`source_blur`, `blending`, and `interpretation_leakage`. Each uncertain item
keeps its existing Memory ids; blending requires two distinct real references
and an existing similarity/cluster relation. No prose or third event is
generated by the projection.

R4-N gates the projection. Clear remembered details with clear provenance do
not receive random unreliability. H's accessibility and decay are read only.
Faded details permit omission, R3 temporal proximity can only warn that order
is unproven, ambiguous selected provenance can warn about source attribution,
and K's current meaning remains separate from historical claims. A private
renderer asks the model to preserve uncertainty and avoid converting later
meaning into what was known during the event. There is no provider call and no
durable holder or writer.

The producer uses the shared post-N cognition seam
`runtime-recall.js#runCurrentMeaningAndNarrative`. Selected provenance flags
are an opt-in, ID-bounded projection from the current Recall selection; O does
not read the Memory database again. Desktop returns the result only within
private cognition context. Mobile appends the same private text to the existing
runtime context before current time; it adds no client field or UI.

```text
MEMORY_UNRELIABILITY_RUNTIME = LIVE
RECONSTRUCTED_RECOLLECTION = LIVE
OMISSION = LIVE
TEMPORAL_BLUR = LIVE
SOURCE_BLUR = LIVE
BLENDING = LIVE
INTERPRETATION_LEAKAGE_GUARD = LIVE
META_MEMORY_GATES_UNRELIABILITY = YES
FABRICATED_EVENT_CREATION = 0
CANONICAL_MEMORY_MUTATION = 0
SEMANTIC_FORGETTING_MUTATION = 0
META_MEMORY_MUTATION = 0
RELATIONSHIP_MUTATION = 0
PERSONA_MUTATION = 0
SELF_NARRATIVE_MUTATION = 0
BEHAVIOR_MODULATION_MUTATION = 0
PREDICTION_ERROR_MUTATION = 0
FAILURE_FALLBACK = LIVE
P21_R4_O_STATUS = COMPLETE
P21_R4_O_FREEZE = FROZEN
```

The append-only contract is q-58 in
[`RECONSTRUCTIVE_MEMORY_CONTRACT.md`](../contracts/memory/RECONSTRUCTIVE_MEMORY_CONTRACT.md).

## 27. P21-R4-P · Shared Memory

R4-P keeps role-authored and user-authored Memory references separate in a
turn-scoped `shared-memory-view-v1`. Its closed relation is derived only from
validated cross-side R3 Association edges. With no validated cross-side edge,
the current selected records remain separate one-sided asymmetric views; no
event identity is inferred by bundling unrelated rows. A referenced candidate
from the existing bounded R3 snapshot can contribute author provenance without
another Memory scan. Conflict stays disputed
with no winner. Similarity or alignment is never treated as shared
acknowledgement.

The only producer seam is after R4-N and R4-O in
`runtime-recall.js#runCurrentMeaningAndNarrative`. It consumes the current
Recall's selected provenance, R3 edges, R4-N awareness, and R4-O recollection;
it does not rescan canonical Memory. Existing preference-only Explicit User
Report data is not event history. User-authored canonical records and role-
authored records remain distinguishable by author metadata, while unknown or
ambiguous authors do not establish a side. The P5 report capability is not
rewritten or repurposed.

`jointly_acknowledged` requires exact source refs, explicit confirmation from
both sides, and a server-owned verifier. Production has no event-acknowledgment
authority assembled, so the status remains authority-gated. The private
cognition reminder preserves source, disagreement, and R4-O uncertainty; it
cannot update Memory, relationship, persona, Self Narrative, behavior
modulation, or Prediction Error. Failure omits the view and leaves the existing
Recall/K/L/N/O path usable. Mobile uses its existing private cognition context
and adds no client DTO or UI.

```text
SHARED_MEMORY_RUNTIME = LIVE
CO_CONSTRUCTED_MEMORY_VIEW = LIVE
ASYMMETRIC_MEMORY = SUPPORTED
DISPUTED_MEMORY = SUPPORTED
JOINT_ACKNOWLEDGEMENT = AUTHORITY_GATED
AUTOMATIC_TRUTH_MERGE = 0
CANONICAL_MEMORY_MUTATION = 0
FAILURE_FALLBACK = LIVE
P21_R4_P_STATUS = COMPLETE
P21_R4_P_FREEZE = FROZEN
```

The append-only contract is q-59 in
[`RECONSTRUCTIVE_MEMORY_CONTRACT.md`](../contracts/memory/RECONSTRUCTIVE_MEMORY_CONTRACT.md).

## 28. P21-R4-Q · Counterfactual Memory

Q is a post-K/L/N/O/P, turn-scoped alternative-history view. The current user
message must supply one explicit conditional premise. The runtime binds that
premise to one clear R4-O-preserved K historical claim and one canonical
character Memory row; it skips the branch if either provenance or grounding is
missing. Shared Memory disputes on the anchor are left unresolved and block a
single-outcome alternative.

The actual recorded claim and the tentative alternative occupy separate
fields. Q's model schema cannot write either the premise or actual result; the
system carries them with provenance and checks the alternative for tentative
language, source references, and unsupported participants. R3 continuation or
contextualization, K current meaning, and sealed P.E evidence may inform
`causalBasis`, but only a verified sealed RealityEvent `causationId` link earns
`plausible`; other supported bases remain `uncertain`. Missing causal basis
returns no view.

The only integration seam is
`runtime-recall.js#runCurrentMeaningAndNarrative`. Q reuses the current Recall
snapshot and the existing R4-E bounded runner, with a Q-specific structured
validator, one call maximum, and a bounded replay cache. Its P3/P.E and P1
access is read-only and scope-bound. It does not create or settle Predictions,
write P4, rewrite Self Narrative, or mutate any other authority. Failure
omits the view; Desktop and Mobile keep using the existing private cognition
context.

```text
COUNTERFACTUAL_RUNTIME = LIVE
ALTERNATIVE_HISTORY_VIEW = LIVE
FACTUAL_ANCHOR_PRESERVED = YES
ACTUAL_VS_COUNTERFACTUAL_SEPARATION = VERIFIED
CAUSAL_BASIS_REQUIRED = YES
UNCERTAINTY_SUPPORTED = YES
FABRICATED_HISTORY_CREATION = 0
PREDICTION_CREATION = 0
PREDICTION_SETTLEMENT_MUTATION = 0
P4_MUTATION = 0
FAILURE_FALLBACK = LIVE
P21_R4_Q_STATUS = COMPLETE
P21_R4_Q_FREEZE = FROZEN
```

The append-only contract is q-60 in
[`RECONSTRUCTIVE_MEMORY_CONTRACT.md`](../contracts/memory/RECONSTRUCTIVE_MEMORY_CONTRACT.md).

## 29. Memory System v1 Engineering Closure

The current cross-phase authority graph, durability matrix, Desktop/Mobile capability truth, mutation audit, fallback chain, test-red classification, and post-v1 limits are recorded in
[MEMORY_SYSTEM_V1_CLOSURE.md](../contracts/memory/MEMORY_SYSTEM_V1_CLOSURE.md).

That closure record is the current status index. Earlier roadmap and phase text remains append-only historical state.
