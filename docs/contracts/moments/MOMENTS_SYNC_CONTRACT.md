# Moments Sync Contract

**Status: Canonical**
**Scope: Browser ↔ Home Node Moments synchronization and hydration**

> Current-state contract. Source: `assets/js/moments-authority.js`, `assets/js/home-node-client.js`
> (`createMomentsRemote`), `assets/js/home-node-bootstrap.js`, `tests/test_moments_authority.js` /
> `test_p11_3f_moments_hydration_safety.js`.

---

## 1. Direction Summary

| Direction | Trigger | Data | Strategy |
| --- | --- | --- | --- |
| Browser → Home Node | create / update / delete | record payload | Home Node authoritative; CAS + idempotency |
| Home Node → Browser | hydrate / changes | records, tombstones | mirror replaced/patched from canonical |
| Companion → Home Node | none | — | Companion does not persist (see `MOMENTS_COMPANION_CONTRACT.md`) |

`moments_revision` is an isolated namespace (a Moment write does not invalidate chat/memory cursors).

---

## 2. Browser → Node

- Endpoints: `POST /moments/record` (single), `POST /moments/records` (batch), `DELETE /moments/record`.
- `requestId` provides **idempotency** (replay → `replayed`, no duplicate write).
- `expectedRev` provides **CAS** on update; a mismatch is rejected (no silent overwrite of a concurrent
  edit).
- Writes go to the Home Node **first**; the browser mirror is updated on success.

---

## 3. Node → Browser

```
ensureReady()
  ├ not hydrated → hydrate()  (GET /moments/list)
  │     → replaceAll(records)            ← authoritative replace
  └ hydrated     → GET /moments/changes?cursor=
        → apply upserts / tombstones ; cursor advances
```

Additional read/ack endpoints: `GET /moments/visible` (visibility-scoped), `POST /moments/ack`,
`GET /moments/migration`.

---

## 4. Hydration Contract (P11-3F)

```
ONE CANONICAL REMOTE STATE — ONE LOCAL MIRROR
```

- Hydration performs an **authoritative replace** (`replaceAll`), not a merge.
- The authority **rejects**:
  - incomplete snapshots → `incomplete-snapshot`;
  - invalid responses → `invalid-response`.
- A `hydrateGen` watermark ensures a stale hydrate cannot overwrite a newer one.
- A refused hydrate leaves the prior mirror state intact.

> Moments hydration behavior differs from the Memory historical hazard documented in `MEMORY.md`:
> Moments refuses a bad page instead of clearing the mirror with it.

---

## 5. Failure Semantics

Local/mirror failures are surfaced with classified errors (`mirror-quota`, `mirror-unavailable`,
`mirror-not-written`, `event-rejected`) rather than reported as success. Remote failure degrades the
authority (`degradedReason`) instead of silently switching authority.

---

## 6. Non-goals

This contract does not define ACL, record fields, or Companion behavior.

---

## 7. Enforcement

| Test | Pins |
| --- | --- |
| `tests/test_p11_3f_moments_hydration_safety.js` | hydrate refusal + gen protection |
| `tests/test_moments_authority.js` | sync / changes / cursor |
| `tests/test_moments_http.js` | Node endpoints |

---

## 8. Historical Origin

`assets/js/moments-authority.js` (canonical hydration contract P11-3F).
