# Memory Authority Contract

**Status: Canonical**
**Scope: Memory storage authority, mirror policy, and write invariants**

> Current-state contract. It fixes who owns durable memory state, how the browser mirror relates to it,
> and the write ordering that keeps them consistent. It does not describe retrieval scoring
> (see [`../../architecture/MEMORY.md`](../../architecture/MEMORY.md)) or the record shape
> (see [`MEMORY_RECORD_CONTRACT.md`](MEMORY_RECORD_CONTRACT.md)).

---

## 1. Authority

```
Home Node  = canonical      (services/home-node/memory-store.js)
Browser    = mirror         (IndexedDB store `memories`)
Mobile     = denied         (no memory verb, no cache)
```

- Canonical durable state is Home Node `memory_records` (plus `memory_change_log` and `memory.*` meta).
- The browser IndexedDB `memories` store is a **mirror / migration source / rollback shadow**.
- Mobile has no memory authority, no memory sync, and no memory cache.

Evidence: `assets/js/memory-authority.js`; `assets/js/home-node-bootstrap.js` (memory authority assembly);
`docs/HOME_NODE_CHAT.md §15`; `services/home-node/http.js` `memoryPolicy`; `services/home-node/mobile-gateway.js`.

---

## 2. Write Invariant (canonical mode)

```
write request
   │
   ▼
Home Node write (POST /memory/records)
   │
   ├─ success ─► apply to browser mirror
   │
   └─ failure ─► NO mirror-only write; fail closed
```

- The canonical write goes to the Home Node **first**.
- The mirror is updated only after a successful canonical write.
- On Home Node failure in canonical mode, the write **fails closed**; it is **never** recorded
  mirror-only as if it were canonical.

Evidence: `assets/js/memory-authority.js` (put path; `authority:'home-node'` vs `mirrorOnly:true`);
`home-node-bootstrap.js` memory authority notes.

---

## 3. Modes

| Mode | Meaning |
| --- | --- |
| `canonical` | **Default.** Home Node is authority; writes are remote-first and fail closed. |
| `mirror` | Legacy rollback mode; browser reads/writes the mirror. |
| `off` | Authority disabled; behaves like mirror for reads/probing. |

`MODES = ['canonical','mirror','off']`, default `canonical` (`assets/js/memory-authority.js`).
A `file://` origin cannot reach the Home Node and is degraded (it cannot be canonical).

---

## 4. Read Decoration

Reads are served locally but decorated with their provenance: `authority:'home-node'` and a `readFrom`
value of `mirror`, `mirror-cold`, or `mirror-degraded`. Reading a mirror is not the same as reading
canonical state, and the decoration makes that explicit.

---

## 5. Non-goals

This contract does not fix retrieval scoring, consolidation decisions, UI rendering, or the record
field list. It does not make the browser mirror a durable authority under any mode.

---

## 6. Enforcement

| Test | What it pins |
| --- | --- |
| `tests/test_memory_authority.js` | modes, write order, fail-closed, watermark, degraded reasons |
| `tests/test_mobile_memory_read_boundary.js` | device cannot reach memory |
| `tests/test_mobile_memory_continuity.js` | browser/Node retrieval parity |

---

## 7. Historical Origin

`docs/HOME_NODE_CHAT.md §15` (M1-C.2d Wave 2). Historical evolution:
`docs/history/runtime/CONTEXT-CONVERGENCE-C1-REPORT.md`.
