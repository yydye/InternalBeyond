# Memory Architecture

**Status: Canonical**
**Scope: Current Memory Architecture**

> Current-state description of the InternalBeyond Memory subsystem: how memory is stored, retrieved,
> scored, admitted, consolidated, and who owns it. It is not a migration report, phase report, or audit.
> Source-of-truth priority: production code → enforcement tests → current contracts → audit → history.

---

## 1. Purpose

Memory is IB's durable, explainable long-term memory for characters: a set of structured records that
are scored, ranked, and selectively injected into model context, plus a consolidation/admission layer
that decides what is worth remembering. It is deliberately **text-scored retrieval, not a vector
store** (see `DECISIONS.md` D14/D15).

Memory **is not**: a model executor, a Middle Brain component, an Android feature, or a provider cache.

---

## 2. Runtime Position

| Module | Layer | Role |
| --- | --- | --- |
| `services/home-node/memory-store.js` | Node / Home Node | canonical durable storage (`memory_records`), revision, idempotency, migration watermark |
| `services/home-node/memory-retrieval.js` | Node / Home Node | canonical retrieval rendering for the Home Node execution path |
| `assets/js/memory-contract.js` | shared UMD | record contract: content vs telemetry, fingerprint, `owner_id`, structural validation |
| `assets/js/memory-retrieval-core.js` | shared UMD | **the only** scoring / relevance / ranking / budget / rendering implementation |
| `assets/js/memory-authority.js` | Browser | authority/mirror/fallback policy (canonical / mirror / off) |
| `assets/js/memory-visibility-core.js` | shared UMD | visibility/ACL predicate (C1 fail-closed) |
| `assets/js/memory.js` | Browser | UI + producers (`quickCreateMemory`) + consolidate + export/import |
| `assets/js/memory/auto-memory.js` | Browser | AI-driven memory creation/update + admission |

Authority model details are in [`../contracts/memory/MEMORY_AUTHORITY_CONTRACT.md`](../contracts/memory/MEMORY_AUTHORITY_CONTRACT.md).

---

## 3. Storage Boundary

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

- **Home Node owns durable Memory state.** `memory_records` (+ `memory_change_log`, `meta['memory_schema']`,
  `meta['memory_revision']`) in the shared `home-node.db`.
- **Browser IndexedDB is a mirror.** It is a migration source and rollback shadow; it is never the
  durable authority. (`assets/js/core.js` store `memories`; authority model in `HOME_NODE_CHAT.md §15`.)
- **Mobile has no Memory authority.** There is no memory verb and no memory cache on devices.

Home Node **owns**: records, revision, schema, idempotency.
Home Node **does not own**: UI rendering, client scoring, consolidation decisions — those are browser-side.

---

## 4. Memory Lifecycle

| Operation | Owner | Storage | API | Consumer |
| --- | --- | --- | --- | --- |
| Create | browser constructors (`quickCreateMemory` and producers) → authority | Home Node (then mirror) | `POST /memory/records` | chat / diary / moments / letters / activity |
| Store | **Home Node** | `memory_records` | — | — |
| Read | Memory subsystem (shared retrieval core) | canonical / mirror for UI | `GET /memory/list`, `GET /memory/changes` | chat / UI / Middle Brain |
| Update | Memory authority (Home Node overwrite) | canonical + change_log | `POST /memory/records` | user edit / consolidation |
| Activate | Home Node (promoted columns only) | canonical | `POST /memory/activate` | retrieval |
| Sync | Home Node → browser mirror | mirror | `/memory/list`, `/memory/changes` | bootstrap |
| Export / Import | Browser | mirror JSON | (local) | user backup |
| Migration | client bootstrap + Home Node watermark | canonical | `/memory/migration`, `/memory/migrate` | one-shot |
| Consolidation | Browser | via authority | — | runtime |
| Delete | Home Node soft delete | canonical + mirror | `POST /memory/records` | user / runtime |

Being able to **read** memory does not confer lifecycle ownership. Durable lifecycle is owned by the
Memory subsystem (Home Node).

---

## 5. Retrieval Architecture

`assets/js/memory-retrieval-core.js` is the single implementation of scoring, relevance, ranking,
budget, and line rendering; both the browser (`memory.js`) and the Home Node
(`services/home-node/memory-retrieval.js`) delegate to it.

Ordering (unchanged, non-negotiable):

```
candidate set → visibility/ACL → relevance → ranking → top-k / budget → rendered context
```

- **Scoring** (`getMemoryScore`): `importance × activationFactor × decayFactor × emotionFactor`;
  `pinned` → 999. Activation is tracked outside the canonical revision stream.
- **Visibility/ACL**: `memory-visibility-core.js`, fail-closed (a missing/malformed `visibility` is
  preserved and resolves to not-visible, never to public).
- **Budget**: bounded injection; retrieval does not grow with the memory library.

---

## 6. Admission

Admission (P11-2J) gates whether memory work is performed for a turn. It is a browser-side, runtime
concern and does not own storage. See `tests/test_p11_2j_memory_admission.js`.

---

## 7. Consolidation

Consolidation is a **browser-side** process (`assets/js/memory/auto-memory.js`, `memory.js`).

Consolidation **owns**: summarize, merge, deduplicate, score, provenance (`consolidatedFrom`,
`lastConsolidatedAt`).
Consolidation **does not own**: durable storage, sync, lifecycle, retrieval authority.

> **Consolidation ≠ Storage Authority.** Consolidation writes through the same authority path
> (`quickCreateMemory` → authority). `lastConsolidatedAt` is a watermark, not content.

---

## 8. Consumer Matrix

| Consumer | Read | Write | Authority |
| --- | --- | --- | --- |
| Chat | yes (`getMemoryContext`) | yes (`quickCreateMemory`, auto-memory, `<mem_*>` via gate) | consumer |
| Group Chat | public-only memory | via group memory policy | consumer |
| Role DM | role-scoped visibility | `roleLetterMemories` (separate store) | consumer |
| Diary | — | `source:'diary'` (importance ≥ 6, similarity < 0.8) | consumer |
| Moments | moments context | via moments chain | consumer |
| Letters | — | `role_letter` (importance 6) | consumer |
| Middle Brain | selected context, read + compress | **no** | read-only |
| Mobile | **no** | **no** | denied |

Consumer ≠ Owner. No consumer other than the Memory subsystem owns durable memory state.

---

## 9. Middle Brain Boundary

Per [MIDDLE_BRAIN.md](MIDDLE_BRAIN.md), the Middle Brain **reads selected context and compresses** it.
The Memory subsystem owns the lifecycle.

- ❌ Middle Brain does not manage memory.
- ❌ Middle Brain does not own memory context.
- ✅ Middle Brain reads a caller-provided memory context / snapshot and returns compressed context.

---

## 10. Chat / Diary / Moments Boundary

Chat, Diary, Moments, Letters, and Activity are **producers and consumers**, not owners. They create
memory through the shared producer path and read through the shared retrieval core. Their own stores
(`diary_entries`, `moments`, `roleLetterMemories`, `chatSummaries`, …) are separate and are **not**
migrated to Home Node memory authority (see `HOME_NODE_CHAT.md §15`).

---

## 11. Export Boundary

The Memory export/import surface is browser-side (`memory.js` `exportMemories` / `importMemoriesFile`)
and operates on the **browser mirror**.

> Current export is browser mirror export, **not** canonical Home Node export.

It must not be described as an official memory backup or canonical archive.

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

This is recorded from code and the client's own comment (`assets/js/home-node-client.js`
`_unwrapMemoryEnvelope`), not fixed here. See `MEMORY_SYNC_CONTRACT.md` §Hydration.

---

## 13. Non-goals

Memory does not own: model execution, provider selection, Middle Brain composition, Android/mobile
surfaces, provider prompt cache, or the durable state of other browser stores (`understandings`,
`threads`, `chatSummaries`, `diary_entries`, `moments`, `posts`, `calEvents`, `activities`).

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

Runtime behavior is enforced by these tests; this document is human canonical authority.

---

## 15. Historical References

Historical documents describe evolution; they do not carry current authority.

- `docs/HOME_NODE_CHAT.md` §15 — M1-C.2d Wave 2 canonical memory authority (contract origin)
- `docs/DECISIONS.md` — D12/D14/D15 and the storage-authority comparison
- `docs/MEMORY.md` — retrieval/scoring narrative (pre-authority model)
- `docs/history/runtime/CONTEXT-CONVERGENCE-C1-REPORT.md`
- `docs/history/runtime/P2-CONTEXT-CONVERGENCE-AUDIT.md`
