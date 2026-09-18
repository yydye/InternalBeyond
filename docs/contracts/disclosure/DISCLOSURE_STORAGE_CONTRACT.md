# Disclosure Storage Contract

**Status: Canonical**
**Scope: Disclosure fact storage surface**

> Current-state contract derived from `assets/js/disclosure-store.js`, `assets/js/core.js`
> (`disclosureFacts` store, `DB_VER 24`), and `tests/test_disclosure_store_smoke.js`.

---

## 1. Storage

| Aspect | Value |
| --- | --- |
| Database | `InternalBeyondDB` (`DB_VER 24`) |
| Store | `disclosureFacts` |
| Key | `factId` |
| Scope | **browser-local persisted store** |

No schema migration, revision, cursor, or lifecycle beyond the store record itself.

---

## 2. CRUD Surface

`disclosure-store.js` exposes `createFact(writerContext, userInput)` (`factId` generated at the store
layer), `listFacts(ownerCharacterId)` (partition by `ownerCharacterId`), `updateFact`, `deleteFact`.
IO is injected (`dbPut` / `dbGet` / `dbGetAll` / `dbDelete`).

The store is **CRUD-only** and deliberately holds **no decision logic**.

---

## 3. Storage ≠ Decision Authority

```
disclosure-store.js  =  CRUD storage surface
disclosure-authorization-core.js  =  authorization authority
```

Persisting facts does not make the store the Disclosure authority owner.

---

## 4. No Home Node Authority

Verified: **no Home Node disclosure table, no revision, no cursor, no Home Node migration**, and **no
`canonical` / `mirror` / `off` authority mode**. Disclosure does not use the Memory/Moments authority
pattern.

---

## 5. Export Boundary

`disclosureFacts` is **excluded** from `_ibBuildExportData` (in `core.js`).

> Disclosure facts are persisted browser-locally but excluded from the current general export surface.

Fact only; this contract does not evaluate or change export behavior.

---

## 6. Non-goals

This contract does not define the fact model, authoring, or authorization. It does not design sync,
migration, or a Home Node authority.

---

## 7. Enforcement

| Test | Pins |
| --- | --- |
| `tests/test_disclosure_store_smoke.js` | real-browser write path (requires Chrome/Edge) |

---

## 8. Historical Origin

`assets/js/disclosure-store.js`; `DB_VER 24` addition of `disclosureFacts`.
