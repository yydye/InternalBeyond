# Moments Architecture

**Status: Canonical**
**Scope: Current Moments Architecture**

> Current-state description of the InternalBeyond Moments subsystem. Source-of-truth priority:
> production code → running tests → contracts → canonical docs → history. `MOMENTS.md` is the Moments
> **authority architecture**; social mechanism lives in [`SOCIAL_RUNTIME.md`](../SOCIAL_RUNTIME.md).

---

## 1. Definition

> **Moments is an independent social content subsystem** with its own canonical persistence, ACL, and
> mirror.

It is **not**: the Social authority, a Companion feature, a Memory subsystem, or the character
relationship system.

---

## 2. Social Boundary

```
Social (umbrella — mechanism only)
    └── Moments (independent authority domain)
```

- `docs/SOCIAL_RUNTIME.md` = social **mechanism** authority (the Social Loop, perception, emotion,
  relationship inputs). It is **not** replaced by this document and no `SOCIAL.md` is created.
- `docs/architecture/MOMENTS.md` = Moments **authority architecture**.

---

## 3. Runtime Position

```
Generation
   ├── browser  assets/js/moments.js        (text gen, model call, image decision)
   └── Companion active/moments.js          (background trigger, generation request, event emission)
        │
        ▼
Moments authority  assets/js/moments-authority.js   (canonical / mirror / off; write-first-to-node)
        │
        ▼
Home Node  services/home-node/moments-store.js       (canonical persistence, revision, migration, retrieval, idempotency)
        │
        ▼
Browser mirror  (IndexedDB store `moments`, bootstrap-intercepted) → UI (moments.js / social-network.js)
```

Ownership summary:

- **Browser generation** — text generation, model call, image decision.
- **Companion generation** — background trigger, generation request, event emission (no persistence).
- **Home Node** — canonical persistence, revision, migration, retrieval, idempotency.

Details: [`../contracts/moments/MOMENTS_AUTHORITY_CONTRACT.md`](../contracts/moments/MOMENTS_AUTHORITY_CONTRACT.md).

---

## 4. Storage Authority

Home Node `services/home-node/moments-store.js` is the **canonical authority**. Browser IndexedDB
`moments` is a **mirror / migration source / rollback shadow** (same shape as Memory/chat).

| Concern | Owner |
| --- | --- |
| create | Home Node |
| update | Home Node |
| delete | Home Node (soft delete) |
| revision | Home Node (`moments_revision`) |
| cursor | Home Node (`change_log`) |
| migration | Home Node (watermark `migration:moments:*`) |
| idempotency | Home Node (`idempotency` + `requestId`) |
| retrieval | Home Node (`moments-retrieval.js`) |

---

## 5. Authority Modes

`MODES = ['canonical','mirror','off']`, default `canonical`; `authorityEffective = canonical && !fileOrigin`.

| Mode | Meaning |
| --- | --- |
| `canonical` | Home Node authority; **write first to node, then mirror**; CAS via `expectedRev`; idempotent `requestId` |
| `mirror` | browser IndexedDB is the effective authority (legacy / rollback) |
| `off` | local only |

No additional mode exists.

---

## 6. Record

Each Moment is a record with promoted query columns and a `payload_json` holding the rest (comments,
likes, images). Full field contract: [`../contracts/moments/MOMENTS_RECORD_CONTRACT.md`](../contracts/moments/MOMENTS_RECORD_CONTRACT.md).

---

## 7. Sync & Hydration

- **Browser → Node**: `put` / `remove` via `/moments/record` (batch `/moments/records`), with
  `requestId` idempotency and `expectedRev` CAS.
- **Node → Browser**: `hydrate` via `/moments/list` (authoritative **replaceAll**) and incremental
  `/moments/changes?cursor=`; visibility-scoped reads use `/moments/visible`; `/moments/ack` supports
  acknowledgement.
- **Hydration contract (P11-3F)**: `ONE CANONICAL REMOTE STATE — ONE LOCAL MIRROR`; the authority
  **rejects incomplete snapshots** (`incomplete-snapshot`) and **invalid responses** (`invalid-response`)
  and uses a `hydrateGen` watermark so a stale hydrate cannot overwrite a newer one.

> Moments hydration behavior differs from the Memory historical hazard (documented in `MEMORY.md`):
> Moments refuses bad hydration rather than replacing the mirror with an empty/invalid page.

Details: [`../contracts/moments/MOMENTS_SYNC_CONTRACT.md`](../contracts/moments/MOMENTS_SYNC_CONTRACT.md).

---

## 8. Visibility / ACL

`assets/js/moments-visibility-core.js` is the single runtime-neutral visibility predicate, shared by
browser and Node.

- **Visibility ≠ disclosure authorization.** Moments visibility is its own ACL; `disclosureFacts` is a
  separate subsystem and is not the Moments ACL.
- Read side fails closed (`invalid` ⇒ author-only); write side defaults missing to `all`.
- Callers must filter with the predicate **before** sort/slice/top-k/paging.

Full contract: [`../contracts/moments/MOMENTS_ACL_CONTRACT.md`](../contracts/moments/MOMENTS_ACL_CONTRACT.md).

---

## 9. Companion Boundary

Companion (`active/moments.js`) **executes** background Moments work — trigger, generation, `wantImage`
recommendation, event emission — but does **not** own Moments.

> Companion executes Moments work ≠ Companion owns Moments authority.

Full contract: [`../contracts/moments/MOMENTS_COMPANION_CONTRACT.md`](../contracts/moments/MOMENTS_COMPANION_CONTRACT.md).

---

## 10. Image Boundary

`wantImage` is a **model recommendation**, not an image generation. The browser Image Router executes
generation on ingest; the Moments authority saves the resulting metadata.

```
Model ── wantImage / imagePrompt (recommendation)
Browser ── Image Router ── image generation
Moments authority ── save metadata
```

Moments does not generate images; the Companion never calls an image interface (it only emits
`wantImage`).

---

## 11. Memory Boundary

Moments does not own Memory and does not manage its lifecycle or consolidation.

| Action | Owner |
| --- | --- |
| read memory | Memory subsystem (chat runtime / retrieval core) |
| write memory | Memory producers via Memory authority |
| consolidation | Memory subsystem |

See [`MEMORY.md`](MEMORY.md) and [`../contracts/memory/`](../contracts/memory/).

---

## 12. Middle Brain Boundary

Moments generation does **not** go through the Middle Brain. `moments.js` calls the model via
`callApiChat` with `_ibConsumer:'moments'` (direct), and Companion generation uses
`active/model-client`. Moments generation ≠ MB authority. See [`MIDDLE_BRAIN.md`](MIDDLE_BRAIN.md).

---

## 13. Provider Boundary

There is **no Moments provider**. Moments generation uses the **character provider/model** through the
shared execution port (`callApiChat` / `active/model-client.callCharacterModel`). The shared port is an
execution abstraction, not provider authority.

---

## 14. Social Network & Reply Chain Boundaries

- `assets/js/social-network.js` = a **view/graph layer over Moments** (list/like/comment/delete); it is
  not a persistence owner and not a Moments owner.
- `assets/js/reply-chain-core.js` = a **deterministic mechanism** (affinity/decay/authorization
  selection + prompt text), shared browser + Node; not storage, scheduling, or social-graph authority.

---

## 15. UI

Moments feed / social page / controls / display are a **surface**. They are not storage, ACL, or
Moments authority.

---

## 16. Non-goals

Moments does not own: Social mechanism, Companion authority, Memory, relationship, disclosure,
image execution, or the social graph. It does not define provider selection or the Middle Brain.

---

## 17. Enforcement

| Concern | Tests |
| --- | --- |
| Authority / mirror | `test_moments_authority.js`, `test_moments_browser_authority.js` |
| Canonical closure / mutations | `test_p11_3e_moments_canonical_closure.js`, `test_p11_3e_moments_mutations.js` |
| Hydration safety | `test_p11_3f_moments_hydration_safety.js` |
| ACL / visibility | `test_moments_acl_contract.js` |
| Home Node HTTP | `test_moments_http.js` |
| Companion boundary | `test_moments_companion.js` |
| Social network / reply chain | `test_socialnet_*` |

Runtime behavior is enforced by these tests; this document is human canonical authority.

---

## 18. Historical References

Provenance only: `docs/SOCIAL_RUNTIME.md`; P11-3E/3F moments phase records (history); `.dsh-research`
authority plans (excluded workspace).
