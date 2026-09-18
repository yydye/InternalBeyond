# Memory 架构

**Status: Canonical**
**Scope: 当前 Memory 架构**

> InternalBeyond Memory 子系统的当前状态描述：memory 如何被存储、检索、评分、admitted、
> consolidated，以及谁拥有它。它不是 migration report、phase report 或 audit。
> Source-of-truth 优先级：生产代码 → enforcement tests → 当前 contracts → audit → history。

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

---

## 6. Admission

Admission（P11-2J）决定某个 turn 是否执行 memory work。它是 browser-side 的 runtime
关注点，不拥有 storage。见 `tests/test_p11_2j_memory_admission.js`。

---

## 7. Consolidation

Consolidation 是一个 **browser-side** 过程（`assets/js/memory/auto-memory.js`、`memory.js`）。

Consolidation **owns**：summarize、merge、deduplicate、score、provenance（`consolidatedFrom`、
`lastConsolidatedAt`）。
Consolidation **does not own**：durable storage、sync、lifecycle、retrieval authority。

> **Consolidation ≠ Storage Authority。** Consolidation 通过同一条 authority path
> 写入（`quickCreateMemory` → authority）。`lastConsolidatedAt` 是 watermark，而非 content。

---

## 8. Consumer 矩阵

| Consumer | Read | Write | Authority |
| --- | --- | --- | --- |
| Chat | 是（`getMemoryContext`） | 是（`quickCreateMemory`、auto-memory、经由 gate 的 `<mem_*>`） | consumer |
| Group Chat | 仅 public 的 memory | 经由 group memory policy | consumer |
| Role DM | role-scoped visibility | `roleLetterMemories`（独立 store） | consumer |
| Diary | — | `source:'diary'`（importance ≥ 6、similarity < 0.8） | consumer |
| Moments | moments context | 经由 moments chain | consumer |
| Letters | — | `role_letter`（importance 6） | consumer |
| Middle Brain | 选定的 context，read + compress | **否** | read-only |
| Mobile | **否** | **否** | denied |

Consumer ≠ Owner。除 Memory subsystem 外，没有任何 consumer 拥有 durable memory state。

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

Runtime 行为由这些 tests 强制；本文档是人类 canonical authority。

---

## 15. Historical References

历史文档描述演进；它们不承载当前 authority。

- `docs/HOME_NODE_CHAT.md` §15 — M1-C.2d Wave 2 canonical memory authority（contract 起源）
- `docs/DECISIONS.md` — D12/D14/D15 与 storage-authority 对比
- `docs/MEMORY.md` — retrieval/scoring 叙述（pre-authority model）
- `docs/history/runtime/CONTEXT-CONVERGENCE-C1-REPORT.md`
- `docs/history/runtime/P2-CONTEXT-CONVERGENCE-AUDIT.md`
