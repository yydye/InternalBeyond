# Memory Record Contract

**Status: Canonical**
**Scope: The canonical memory record object**

> Current-state contract for the memory record: fields, content-vs-telemetry separation, identity,
> ownership, and structural validation. Derived from `assets/js/memory-contract.js`; it does not invent
> fields and does not add to the existing vocabulary.

---

## 1. Record Shape

A memory record is a JSON object persisted verbatim as `payload_json`, with a small set of fields
promoted to query columns.

| Group | Fields | Notes |
| --- | --- | --- |
| Identity | `id` | primary key (`record_id`); required, non-empty, ≤ 200 chars |
| Content | `title`, `summary`, `content` | human-visible text |
| Classification | `domain`, `category`, `tags[]`, `kind` | `kind` → promoted `class` (default `episodic`) |
| Affect | `valence` (0–1), `arousal` (0–1) | scoring inputs |
| Weight | `importance` (1–10), `resolved`, `pinned` | scoring / decay |
| Ownership | `createdBy`, `createdByName` | `owner_id` is derived from `createdBy` |
| Visibility (ACL) | `visibility`, `visibleTo[]`, `excludeFrom[]` | promoted for pre-filter |
| Provenance | `source`, `sourceId`, `consolidatedFrom` | producer / consolidation |
| Timestamps | `created` (or `createdAt`) | identity, not editable |
| Telemetry | `activationCount`, `lastActivated`, `lastConsolidatedAt`, `visibilityRepairedAt`, `visibilityRepairReason` | see §3 |

Unknown fields must round-trip through `payload_json`.

---

## 2. Content vs Telemetry

- **Content** affects `contentFingerprint` (stable stringify of the record with telemetry stripped).
- **Telemetry does not affect the fingerprint.** `TELEMETRY_FIELDS` (`memory-contract.js`) are:
  `activationCount`, `lastActivated`, `lastConsolidatedAt`, `visibilityRepairedAt`,
  `visibilityRepairReason`.

Why it matters: activation changes every turn; if it participated in equivalence, a migration re-run
would classify everything as `updated` and break idempotency. Telemetry is excluded from the
**equivalence comparison only** — it is still stored in the payload.

`contentIdentical(a, b)` is defined as fingerprint equality.

---

## 3. Ownership

`owner_id` is the canonical partition key, derived by `ownerIdOf(record)` from `createdBy`, defaulting to
`'user'`. It is a partition key, **not** an ACL. The ACL is `visibility` / `visibleTo` / `excludeFrom`.

---

## 4. Structural Validation

`validateRecord(record)` rejects only what the Home Node cannot safely store:

- not an object → `not-an-object`;
- missing/blank `id` → `missing-id`; `id` longer than 200 → `id-too-long`;
- `visibility` present but not a string → `visibility-not-a-string`;
- `visibleTo` / `excludeFrom` present but not arrays → `visibleTo-not-an-array` / `excludeFrom-not-an-array`.

`visibility` is **deliberately not semantically validated**: a missing or malformed `visibility` must
be stored as-is, because the fail-closed visibility rule depends on "missing stays missing". Coercing a
missing visibility to `'public'` would turn an invisible memory into a public one.

---

## 5. Promoted Columns vs Payload

The Home Node table promotes `owner_id`, `class`, `visibility`, `visible_to`, `exclude_from`,
`importance`, `pinned`, `activation_count`, `last_activated_at`, timestamps, and `revision` for
query/ACL/ranking. `payload_json` holds **every** field. Activation is a two-column `UPDATE`
(`activation_count`, `last_activated_at`) that touches neither `payload_json` nor `revision`.

---

## 6. Non-goals

This contract does not fix retrieval scoring, ranking weights, or UI rendering. It does not add fields
or change the vocabulary.

---

## 7. Enforcement

| Test | What it pins |
| --- | --- |
| `tests/test_memory_contract_closure.js` | fingerprint, telemetry exclusion, validation, owner/class |
| `tests/test_memory_migration.js` | content-identical ⇒ idempotent migration |

---

## 8. Historical Origin

`assets/js/memory-contract.js` (M1-C.2d Wave 2). Pre-authority field narrative: `docs/MEMORY.md §1`.
