# Moments Authority Contract

**Status: Canonical**
**Scope: Moments storage authority and authority modes**

> Current-state contract. Source: `services/home-node/moments-store.js`,
> `assets/js/moments-authority.js`, `assets/js/home-node-bootstrap.js`, `tests/test_moments_authority.js`.
> Record shape → `MOMENTS_RECORD_CONTRACT.md`; sync → `MOMENTS_SYNC_CONTRACT.md`.

---

## 1. Canonical Owner

**Home Node `services/home-node/moments-store.js` is the canonical authority** for Moments. The browser
IndexedDB `moments` store is a **mirror / migration source / rollback shadow**.

Evidence: moments-store schema/revision/migration; `home-node-bootstrap.js` intercepts `moments` store
access and routes it through `moments-authority`.

---

## 2. Ownership

| Concern | Owner |
| --- | --- |
| create | Home Node (`insertRecord` / `putRecord` / `putRecords`) |
| update | Home Node (`updateRecord`, `record_rev`) |
| delete | Home Node (`softDelete`: `deleted_at` / `deleted_rev`) |
| revision | Home Node (`meta['moments_revision']`, isolated namespace) |
| cursor | Home Node (`change_log`, `changesAfter`) |
| migration | Home Node (watermark `migration:moments:*`) |
| idempotency | Home Node (`idempotency` table + `requestId` replay) |
| retrieval | Home Node (`moments-retrieval.js`) |

The browser does not own Moments.

---

## 3. Authority Modes

`MODES = ['canonical','mirror','off']`; default `canonical`; `authorityEffective = canonical && !fileOrigin`.

| Mode | Meaning |
| --- | --- |
| `canonical` | Home Node authority; write-first-to-node then mirror; CAS `expectedRev`; idempotent `requestId` |
| `mirror` | browser IndexedDB is the effective authority (legacy / rollback) |
| `off` | local only |

Remote is enabled only in `canonical` and off `file://`.

---

## 4. Failure Semantics

Errors are classified by level (`mirror-level`, `event-local`) rather than reported as success:
`mirror-quota`, `mirror-unavailable`, `mirror-not-written`, `event-rejected`. CAS mismatch and
idempotent replay are distinct outcomes (`updated` / `skipped` / `replayed`).

---

## 5. Enforcement

| Test | Pins |
| --- | --- |
| `tests/test_moments_authority.js` | modes, write-first, CAS, hydrate |
| `tests/test_moments_browser_authority.js` | browser mirror wiring |
| `tests/test_p11_3e_moments_canonical_closure.js` | canonical closure |
| `tests/test_moments_http.js` | Home Node moments HTTP |

---

## 6. Historical Origin

`services/home-node/moments-store.js`, `assets/js/moments-authority.js` (M1-C.2n P5/P6).
