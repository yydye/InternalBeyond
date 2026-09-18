# Companion Architecture

**Status: Canonical**
**Scope: Current Companion / Active Companion Architecture**

> Current-state description of the InternalBeyond Companion. Source-of-truth priority: production code →
> targeted tests → contracts → audit → current docs → phase/history. Mechanism detail for autonomy
> lives in [`AUTONOMY.md`](../AUTONOMY.md); this document fixes **what the Companion is and what it owns**.

---

## 1. Definition

> **Companion is a bounded background execution surface acting on behalf of a character.**

It runs scheduled background work (proactive messages, background Moments, plan evaluation) when the
browser is closed, queues results, and hands them back to the browser. It is an **executor + queue**,
not a runtime owner.

```
Character ≠ Companion
```

- **Character** owns identity and configuration (persona, speech style, voice preference, provider/model,
  relationship).
- **Companion** provides bounded background execution for that character.

It is **not**: the character runtime, "all character features", the Memory owner, the social owner, or
an autonomous Agent.

---

## 2. Runtime Position

The Companion is a **separate local service** plus a background module set:

| Module | Layer | Responsibility |
| --- | --- | --- |
| `services/active-message-service.js` | Node service (`IB_ACTIVE_PORT`, default `23114`) | durable scheduler outside the browser; queues results until the browser imports + acknowledges |
| `active/scheduler.js` | Node | 15s `schedulerTick`, crash-leftover recovery, history trimming, plan execution |
| `active/model-client.js` | Node | character-model client, prompt build, validation, dedup, fallback |
| `active/plan-domain.js` | Node | plan domain: sanitize, DND, run/message ids, evaluate/send/reschedule/cancel |
| `active/moments.js` | Node | background Moments tick (text + `wantImage` only) |
| `active/proactive-trace.js` | Node | zero-decision observability trace (default off) |
| `assets/js/active-diary.js`, `active-diary/*` | Browser | active settings/plans + diary (browser-owned) |
| `assets/js/proactive-interaction-core.js` | shared UMD | canonical proactive interaction/event/state vocabulary |

Current flow:

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

**The Active service is an executor + queue — not chat storage authority and not message-lifecycle
authority.** Protocol detail: [`../contracts/companion/ACTIVE_RUNTIME_CONTRACT.md`](../contracts/companion/ACTIVE_RUNTIME_CONTRACT.md).

Autonomy mechanism (frequency, DND, retry, dedup, reply-chain, offline degradation) is documented in
[`AUTONOMY.md`](../AUTONOMY.md) and is not restated here.

---

## 3. Character Boundary

| Concern | Authority |
| --- | --- |
| persona | Character configuration |
| speech style | Character configuration / prompt |
| voice preference | Character configuration (see [`VOICE.md`](VOICE.md)) |
| provider / model | Character configuration |
| relationship | Character configuration (`cfg.relationship`) |
| proactive execution | Companion |
| chat storage | Chat Runtime |
| delivery | Chat Runtime |

Voice preference handling is canonical in [`VOICE.md`](VOICE.md) and not copied here.

---

## 4. Relationship Authority

There is **no independent Relationship Engine**. Three distinct concepts must not be merged:

| Concept | What it is | Owner |
| --- | --- | --- |
| `cfg.relationship` | **authoritative relationship attribute** (free text) | Character configuration |
| `disclosureFacts` (`trust / affinity / familiarity / dmCount / relationship / toneCounts / initiative / memorandum`) | **disclosure authorization signals** | Disclosure subsystem |
| `pairAffinity` | **derived / ephemeral interaction weighting** | Moments / reply-chain (runtime) |

```
cfg.relationship  ≠  disclosureFacts  ≠  pairAffinity
```

`docs/DECISIONS.md` D13 (relationship state layer deferred until observation calibrates it) remains the
governing decision. Full contract: [`../contracts/companion/RELATIONSHIP_AUTHORITY_CONTRACT.md`](../contracts/companion/RELATIONSHIP_AUTHORITY_CONTRACT.md).

---

## 5. Active Runtime

- **Schedule ownership**: the browser owns plans/settings (`active_message_plans`,
  `active_message_settings`); only schedules with `background_enabled` are synced to the service.
- **Execution**: schedule → plan-domain → character model → validation → dedup/DND → queue.
- **Queue**: the service durably queues generated results; the queue is **not** canonical chat storage.
- **Import / ack**: the browser imports results and acknowledges them; persistence/delivery then happen
  in the Chat Runtime.
- **Crash recovery**: the scheduler performs crash-leftover recovery and history trimming
  (`active/scheduler.js`).

---

## 6. Proactive Interaction

Proactive interaction is not owned by a single "Companion": the interaction vocabulary is shared
(`proactive-interaction-core.js`: `interaction ∈ text_message | voice_call`), planning/execution is
browser + service, and storage/delivery is the Chat Runtime.

> AI can proactively send a message **≠** Companion owns the message lifecycle.

Contract: [`../contracts/companion/PROACTIVE_INTERACTION_CONTRACT.md`](../contracts/companion/PROACTIVE_INTERACTION_CONTRACT.md).

---

## 7. Memory Boundary

Companion does not own the Memory lifecycle. The Active service does not directly own memory retrieval,
creation, or consolidation. Where Diary/Moments produce memory, that belongs to the respective
**producer + the Memory authority**. See [`MEMORY.md`](MEMORY.md) and
[`../contracts/memory/`](../contracts/memory/).

---

## 8. Diary Boundary

Diary is an **independent browser-side subsystem**, not a Companion output.

| Diary concern | Owner |
| --- | --- |
| Trigger | browser diary planner / tick |
| Generation | browser character-model path |
| Storage | `diary_entries` + diary prefs |

The background Active service does not run diary. Where Diary meets its threshold it is a **Memory
producer under its own policy** (memory authority unchanged).

---

## 9. Moments Boundary

> Moments 的 canonical authority 见 [`MOMENTS.md`](MOMENTS.md) 与 [`../contracts/moments/`](../contracts/moments/)；本节仅述 Companion 边界。

Moments is an **independent Social subsystem**, not Companion-owned. It has three surfaces: browser
Moments, a **Companion background execution surface** (`active/moments.js`), and the **Home Node
canonical Moments authority** (`services/home-node/moments-store.js`). The Companion merely *executes*
background Moments work; it does not own Moments. See [`SOCIAL_RUNTIME.md`](../SOCIAL_RUNTIME.md).

---

## 10. Letters Boundary

Two distinct letter surfaces, with separate storage:

- **User ↔ Character** letters (`assets/js/communication/letters.js`);
- **AI ↔ AI Role letters** (`assets/js/role-letters.js`, `roleLetterMemories` store).

Neither is Companion-owned; only the Character/Companion interaction boundary applies.

---

## 11. Agent Boundary

> Proactive Chat **≠** Autonomous Agent.

Companion does not own an autonomous tool loop, task planner, tool-execution authority, budget loop, or
FC loop. `assets/js/agent-runtime.js` is a **Runtime Core + Model Execution Port** (provider-neutral
execution abstraction), not a Companion agent. Economy capabilities
(`active/commerce.js`, `active/economy-channel-client.js`, `active/payment-auth.js`,
`active/shopping-execution.js`) belong to **Economy**, not Companion.

---

## 12. Provider Boundary

Companion has **no independent provider**. All surfaces use the **character's provider/model/credential**:

| Usage | Model authority |
| --- | --- |
| normal character reply | character |
| proactive message | character |
| diary | character |
| letters | character |
| moments | character |

`active/node-model-port.js` / `agent-runtime.js` are **execution abstractions** (a provider-neutral
port), not provider authority.

---

## 13. Configuration

| Config | Storage | Runtime reader | Authority |
| --- | --- | --- | --- |
| active settings | `active_message_settings` (IndexedDB) | browser; synced to service | browser |
| active history | `active_message_history` (IndexedDB) | browser / service history | browser |
| active plans | `active_message_plans` (IndexedDB) | browser + plan domain | browser |
| AI prefs | `ib_active_ai_prefs_v1` (localStorage) | browser | browser |
| diary prefs | `ib_diary_prefs_v1` (localStorage) | browser diary | diary subsystem |
| service port | env `IB_ACTIVE_PORT` (default 23114) | service | service |
| character persona / relationship / voice / provider | character config | browser + service | character |

Storage is not changed by this document.

---

## 14. UI Boundary

UI is a display / settings / relationship-view / control surface. It is **not** runtime authority,
storage authority, or relationship authority.

---

## 15. Consumer Matrix

| Surface | Companion role | Own authority |
| --- | --- | --- |
| Normal Chat | none (background relation only) | Chat Runtime |
| Proactive Message | executor | Browser plans + Chat Runtime delivery |
| Voice Call | interaction type / support | Voice + Chat Runtime |
| Diary | no ownership | Diary subsystem |
| Moments | background executor only | Moments subsystem (Home Node canonical) |
| Letters | no ownership | Letters subsystem |
| Memory | consumer boundary only | Memory subsystem |
| Economy | no ownership | Economy subsystem |

---

## 16. Non-goals

Companion does not own: chat storage, message lifecycle, Memory, Diary, Moments, Letters, Economy,
relationship state, provider/model credentials, or autonomous agent loops. It does not introduce a
relationship engine, a relationship score, or a new schema.

---

## 17. Enforcement

| Concern | Tests |
| --- | --- |
| Active service | `test_active_http.js`, `test_active_plans.js`, `test_active_diary_smoke.js` |
| Proactive interaction | `test_proactive_interaction.js`, `test_proactive_phase2.js`, `test_proactive_trace.js` |
| Runtime convergence | `test_runtime_convergence_proactive.js`, `test_runtime_convergence_diary.js`, `test_runtime_convergence_moments.js` |
| Moments companion | `test_moments_companion.js` |
| Relationship / role / letters / social | `test_role_dm.js`, `test_role_letters.js`, `test_socialnet_*` |

Runtime behavior is enforced by these tests; this document is human canonical authority.

---

## 18. Historical References

Provenance only: `docs/history/platform/ROLE_DM_RELATIONSHIP_PHASE4_AUDIT.md`; the `P19`/`P23`
phase records in the working tree. No large-scale archive is performed here.
