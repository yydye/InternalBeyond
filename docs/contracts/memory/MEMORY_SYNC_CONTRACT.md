# Memory Sync Contract

**Status: Canonical**
**Scope: Browser ↔ Home Node memory synchronization, envelope, and hydration**

> Current-state contract for how the browser mirror stays consistent with the canonical Home Node store,
> and why mobile never participates. It does not define storage authority
> (see [`MEMORY_AUTHORITY_CONTRACT.md`](MEMORY_AUTHORITY_CONTRACT.md)).

---

## 1. Direction Summary

| Direction | Trigger | Data | Conflict strategy |
| --- | --- | --- | --- |
| Browser → Home Node | writes (create/update/delete) | record payload | Home Node authoritative; **fail closed** in canonical mode; never mirror-only |
| Home Node → Browser | first load / `changes(cursor)` | upserts + deletes | mirror is **replaced/patched** from canonical; no merge |
| Mobile ↔ Home Node | — | — | none; memory is denied to devices |

The canonical revision namespace is the memory store's own (`memory_revision`); a memory write must not
invalidate the chat mirror cursor, and vice versa (`HOME_NODE_CHAT.md §15.3`).

---

## 2. Browser → Home Node (write path)

- Writes go through `memory-authority` and land on the Home Node first (`POST /memory/records`).
- Success → the change is applied to the browser mirror.
- Failure → no mirror-only canonical write; the operation fails closed (canonical mode).
- Writes are idempotent via a request key namespaced `mem:` so a memory migration request id cannot
  collide with a chat message request id.

---

## 3. Home Node → Browser (mirror path)

```
ensureReady()
  ├ not yet hydrated → hydrate()
  │     remote.list(seedLimit) → local.replaceAll(page.records)
  │     cursor = page.revision ; hasFullHistory = !page.truncated
  └ already hydrated → remote.changes(cursor)
        → applyDeletes(...) ; applyUpserts(...) ; cursor = res.cursor
```

- `hydrate()` **replaces** the mirror (not merged) so that deleted canonical records do not linger.
- `changes()` applies deletes before upserts and advances the cursor.
- Reads are decorated with `authority:'home-node'` and `readFrom` (`mirror` / `mirror-cold` /
  `mirror-degraded`).

---

## 4. Envelope

`/memory/*` uses the shared Home Node envelope. The client merges `payload` fields into the top level
while preserving envelope metadata (`ok`, `status`, `type`, `serverTime`, `protocolVersion`,
`requestId`) — see `assets/js/home-node-client.js` `_unwrapMemoryEnvelope`.

Memory endpoints are **desktop-only** (`/memory/list`, `/memory/changes`, `/memory/records`,
`/memory/record`, `/memory/activate`, `/memory/settings`, `/memory/migration`, `/memory/migrate`).
They are not exposed through `/mobile/v1`.

---

## 5. Mobile

```
No memory endpoint.
No memory sync.
No memory cache.
```

`services/home-node/mobile-gateway.js` lists all `/memory/*` paths as desktop admin paths, and
`services/home-node/http.js` declares `memoryPolicy: { stored: true, servedToDevices: false,
deviceVerbs: [], injection: 'home-node-execution-only' }`.

---

## 6. Hydration Hazard

```
Known runtime hazard:
  hydrate() executes local.replaceAll(page.records). If the Home Node list
  response is empty, or its payload fails to unwrap (so `res.records` is
  undefined), the mirror is authoritatively cleared and retrieval can render an
  empty context despite canonical records existing.

Status:
  Documented, not fixed in this phase.
```

Recorded from `assets/js/memory-authority.js` (hydrate) and `assets/js/home-node-client.js`
(`_unwrapMemoryEnvelope` comment). This document does **not** fix it.

---

## 7. Non-goals

This contract does not define conflict-merge semantics (there are none in canonical mode), does not
make the mirror authoritative, and does not grant mobile any memory surface.

---

## 8. Enforcement

| Test | What it pins |
| --- | --- |
| `tests/test_memory_authority.js` | hydrate / changes / fail-closed / degraded reasons |
| `tests/test_mobile_memory_continuity.js` | browser/Node parity; device cannot reach memory |
| `tests/test_mobile_memory_read_boundary.js` | device read boundary |

---

## 9. Historical Origin

`docs/HOME_NODE_CHAT.md §15` (M1-C.2d Wave 2); `docs/history/runtime/P2-CONTEXT-CONVERGENCE-AUDIT.md`.
