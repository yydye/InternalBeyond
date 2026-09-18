# Companion 架构

**Status: Canonical**
**Scope: 当前 Companion / Active Companion 架构**

> InternalBeyond Companion 的当前状态描述。真相来源优先级：production code →
> targeted tests → contracts → audit → current docs → phase/history。Autonomy 的机制细节
> 见 [`AUTONOMY.md`](../AUTONOMY.md)；本文档固定 **Companion 是什么以及它拥有什么**。

---

## 1. 定义

> **Companion 是一个代表 character 行事的有界后台执行 surface。**

它在 browser 关闭时运行已调度的后台工作（proactive messages、background Moments、plan
evaluation），将结果排队，并交还给 browser。它是**executor + queue**，而不是 runtime owner。

```
Character ≠ Companion
```

- **Character** 拥有 identity 与 configuration（persona、speech style、voice preference、
  provider/model、relationship）。
- **Companion** 为该 character 提供有界的后台执行。

它**不是**：character runtime、"all character features"、Memory owner、social owner，或
autonomous Agent。

---

## 2. Runtime 位置

Companion 是一个**独立的本地 service** 加上一组后台模块：

| 模块 | 层级 | 职责 |
| --- | --- | --- |
| `services/active-message-service.js` | Node service (`IB_ACTIVE_PORT`, default `23114`) | browser 之外的 durable scheduler；将结果排队直到 browser import + acknowledge |
| `active/scheduler.js` | Node | 15s `schedulerTick`、crash-leftover recovery、history trimming、plan execution |
| `active/model-client.js` | Node | character-model client、prompt build、validation、dedup、fallback |
| `active/plan-domain.js` | Node | plan domain：sanitize、DND、run/message ids、evaluate/send/reschedule/cancel |
| `active/moments.js` | Node | background Moments tick（仅 text + `wantImage`） |
| `active/proactive-trace.js` | Node | zero-decision observability trace（默认关闭） |
| `assets/js/active-diary.js`, `active-diary/*` | Browser | active settings/plans + diary（browser 拥有） |
| `assets/js/proactive-interaction-core.js` | shared UMD | canonical proactive interaction/event/state vocabulary |

当前流程：

```
Browser schedules
       │ sync (reconcile)
       ▼
Active service
       │ plan/domain tick
       ▼
character model
       │ validate / dedup / DND
       ▼
queue result (durable)
       │
       ▼
Browser import + acknowledge
       │
   Chat storage / delivery   ← owned by the Chat Runtime
```

**Active service 是 executor + queue——不是 chat storage authority，也不是
message-lifecycle authority。** Protocol 细节：
[`../contracts/companion/ACTIVE_RUNTIME_CONTRACT.md`](../contracts/companion/ACTIVE_RUNTIME_CONTRACT.md)。

Autonomy 机制（frequency、DND、retry、dedup、reply-chain、offline degradation）记录在
[`AUTONOMY.md`](../AUTONOMY.md) 中，此处不再重述。

---

## 3. Character 边界

| 关注点 | Authority |
| --- | --- |
| persona | Character configuration |
| speech style | Character configuration / prompt |
| voice preference | Character configuration（参见 [`VOICE.md`](VOICE.md)） |
| provider / model | Character configuration |
| relationship | Character configuration（`cfg.relationship`） |
| proactive execution | Companion |
| chat storage | Chat Runtime |
| delivery | Chat Runtime |

voice preference 的处理以 [`VOICE.md`](VOICE.md) 为 canonical，此处不再复制。

---

## 4. Relationship Authority

**不存在独立的 Relationship Engine**。三个彼此不同的概念不得合并：

| 概念 | 它是什么 | 拥有者 |
| --- | --- | --- |
| `cfg.relationship` | **authoritative relationship attribute**（自由文本） | Character configuration |
| `disclosureFacts` (`trust / affinity / familiarity / dmCount / relationship / toneCounts / initiative / memorandum`) | **disclosure authorization signals** | Disclosure subsystem |
| `pairAffinity` | **derived / ephemeral interaction weighting** | Moments / reply-chain (runtime) |

```
cfg.relationship  ≠  disclosureFacts  ≠  pairAffinity
```

`docs/DECISIONS.md` D13（relationship state layer 推迟到 observation 对其校准）仍是起支配作用
的决策。完整 contract：
[`../contracts/companion/RELATIONSHIP_AUTHORITY_CONTRACT.md`](../contracts/companion/RELATIONSHIP_AUTHORITY_CONTRACT.md)。

---

## 5. Active Runtime

- **Schedule ownership**：browser 拥有 plans/settings（`active_message_plans`、
  `active_message_settings`）；只有带 `background_enabled` 的 schedule 才会同步到 service。
- **Execution**：schedule → plan-domain → character model → validation → dedup/DND → queue。
- **Queue**：service 将生成结果持久排队；queue **不是** canonical chat storage。
- **Import / ack**：browser 导入结果并予以确认；随后 persistence/delivery 在
  Chat Runtime 中发生。
- **Crash recovery**：scheduler 执行 crash-leftover recovery 与 history trimming
  （`active/scheduler.js`）。

---

## 6. Proactive Interaction

Proactive interaction 并非由单个 "Companion" 拥有：interaction vocabulary 是共享的
（`proactive-interaction-core.js`：`interaction ∈ text_message | voice_call`），planning/execution
由 browser + service 负责，storage/delivery 由 Chat Runtime 负责。

> AI 可以主动发送消息 **≠** Companion 拥有 message lifecycle。

Contract：
[`../contracts/companion/PROACTIVE_INTERACTION_CONTRACT.md`](../contracts/companion/PROACTIVE_INTERACTION_CONTRACT.md)。

---

## 7. Memory 边界

Companion 不拥有 Memory lifecycle。Active service 不直接拥有 memory retrieval、creation 或
consolidation。当 Diary/Moments 产生 memory 时，那属于各自的
**producer + Memory authority**。参见 [`MEMORY.md`](MEMORY.md) 与
[`../contracts/memory/`](../contracts/memory/)。

---

## 8. Diary 边界

Diary 是一个**独立的 browser-side subsystem**，不是 Companion 的输出。

| Diary 关注点 | 拥有者 |
| --- | --- |
| Trigger | browser diary planner / tick |
| Generation | browser character-model path |
| Storage | `diary_entries` + diary prefs |

后台 Active service 不运行 diary。当 Diary 达到其阈值时，它是**遵循自身策略的 Memory
producer**（memory authority 不变）。

---

## 9. Moments 边界

> Moments 的 canonical authority 见 [`MOMENTS.md`](MOMENTS.md) 与 [`../contracts/moments/`](../contracts/moments/)；本节仅述 Companion 边界。

Moments 是一个**独立的 Social subsystem**，不由 Companion 拥有。它有三个 surface：browser
Moments、一个 **Companion background execution surface**（`active/moments.js`），以及
**Home Node canonical Moments authority**（`services/home-node/moments-store.js`）。Companion
仅仅*执行* background Moments 工作；它不拥有 Moments。参见
[`SOCIAL_RUNTIME.md`](../SOCIAL_RUNTIME.md)。

---

## 10. Letters 边界

> Letters 的 canonical authority 见 [`LETTERS.md`](LETTERS.md) 与 [`../contracts/letters/`](../contracts/letters/)；本节仅述 Companion 边界。

两个彼此不同的 letter surface，拥有各自的 storage：

- **User ↔ Character** letters（`assets/js/communication/letters.js`）；
- **AI ↔ AI Role** letters（`assets/js/role-letters.js`、`roleLetterMemories` store）。

两者都不由 Companion 拥有；仅适用 Character/Companion interaction 边界。

---

## 11. Agent 边界

> Proactive Chat **≠** Autonomous Agent。

Companion 不拥有 autonomous tool loop、task planner、tool-execution authority、budget loop 或
FC loop。`assets/js/agent-runtime.js` 是 **Runtime Core + Model Execution Port**（provider-neutral
的 execution abstraction），不是 Companion agent。Economy 能力
（`active/commerce.js`、`active/economy-channel-client.js`、`active/payment-auth.js`、
`active/shopping-execution.js`）属于 **Economy**，不属于 Companion。

---

## 12. Provider 边界

Companion **没有独立的 provider**。所有 surface 都使用 **character 的
provider/model/credential**：

| 用途 | Model authority |
| --- | --- |
| normal character reply | character |
| proactive message | character |
| diary | character |
| letters | character |
| moments | character |

`active/node-model-port.js` / `agent-runtime.js` 是 **execution abstractions**（一个
provider-neutral 的 port），不是 provider authority。

---

## 13. 配置

| Config | Storage | Runtime 读取方 | Authority |
| --- | --- | --- | --- |
| active settings | `active_message_settings` (IndexedDB) | browser；同步到 service | browser |
| active history | `active_message_history` (IndexedDB) | browser / service history | browser |
| active plans | `active_message_plans` (IndexedDB) | browser + plan domain | browser |
| AI prefs | `ib_active_ai_prefs_v1` (localStorage) | browser | browser |
| diary prefs | `ib_diary_prefs_v1` (localStorage) | browser diary | diary subsystem |
| service port | env `IB_ACTIVE_PORT` (default 23114) | service | service |
| character persona / relationship / voice / provider | character config | browser + service | character |

本文档不改变 Storage。

---

## 14. UI 边界

UI 是展示 / 设置 / relationship-view / 控制 surface。它**不是** runtime authority、
storage authority 或 relationship authority。

---

## 15. 消费者矩阵

| Surface | Companion 角色 | 自有 Authority |
| --- | --- | --- |
| Normal Chat | none（仅后台关联） | Chat Runtime |
| Proactive Message | executor | Browser plans + Chat Runtime delivery |
| Voice Call | interaction type / support | Voice + Chat Runtime |
| Diary | no ownership | Diary subsystem |
| Moments | 仅 background executor | Moments subsystem (Home Node canonical) |
| Letters | no ownership | Letters subsystem |
| Memory | 仅 consumer boundary | Memory subsystem |
| Economy | no ownership | Economy subsystem |

---

## 16. Non-goals

Companion 不拥有：chat storage、message lifecycle、Memory、Diary、Moments、Letters、Economy、
relationship state、provider/model credentials 或 autonomous agent loops。它不引入 relationship
engine、relationship score 或新的 schema。

---

## 17. Enforcement

| 关注点 | 测试 |
| --- | --- |
| Active service | `test_active_http.js`, `test_active_plans.js`, `test_active_diary_smoke.js` |
| Proactive interaction | `test_proactive_interaction.js`, `test_proactive_phase2.js`, `test_proactive_trace.js` |
| Runtime convergence | `test_runtime_convergence_proactive.js`, `test_runtime_convergence_diary.js`, `test_runtime_convergence_moments.js` |
| Moments companion | `test_moments_companion.js` |
| Relationship / role / letters / social | `test_role_dm.js`, `test_role_letters.js`, `test_socialnet_*` |

runtime 行为由这些测试强制执行；本文档是人类可读的 canonical authority。

---

## 18. 历史参考

仅为 provenance：`docs/history/platform/ROLE_DM_RELATIONSHIP_PHASE4_AUDIT.md`；工作树中的
`P19`/`P23` phase 记录。此处不进行大规模归档。
