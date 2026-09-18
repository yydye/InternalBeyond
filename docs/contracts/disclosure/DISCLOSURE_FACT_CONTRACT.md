# Disclosure Fact Contract

**Status: Canonical**
**Scope: The canonical disclosure fact object**

> Current-state contract derived from `assets/js/disclosure-core.js` and `tests/test_disclosure_core.js`.
> Field names are taken from code, not inferred.

---

## 1. Fields

| Field | Meaning |
| --- | --- |
| `factId` | identity (`disc_…` if absent) |
| `ownerCharacterId` | the character whose fact this is (required; undeterminable owner ⇒ reject) |
| `level` | `PUBLIC` / `PERSONAL` / `PRIVATE` / `SECRET` (+ read-side `UNDETERMINED`) |
| `text` | the fact text |
| `subjectCharacterId` | the fact's subject; `''` = about the character themself |
| `source` | provenance (which channel produced the data) |
| `authority` | write authority (who vouches it is true) |
| `authoredBy` | human principal (only for human authorities) |
| `updatedAt` | timestamp |

`normalizeDisclosureFact` never throws; it returns `null` only for a non-object input or an
undeterminable owner (guessing an owner would forge attribution).

---

## 2. Levels

`LEVELS = ['PUBLIC','PERSONAL','PRIVATE','SECRET']`; `GATED_LEVELS = ['PERSONAL','PRIVATE','SECRET']`;
`LEVEL_RANK` orders them `PUBLIC < PERSONAL < PRIVATE < SECRET`.

> `PUBLIC` character information is owned by `publicProfileCore`, **not** formal disclosure
> authorization. Public Profile ≠ Formal Disclosure. Do not fold `PUBLIC` into the disclosure decision.

---

## 3. Writer Authority

Two separate axes:

- `source` — **provenance**: `character_authoring`, `user_authoring`, `user_correction`,
  `memory_extraction`, `role_dm_conversation`, `diary`, `consolidation`, `generated_inference`,
  `unknown`. `AUTHORED_SOURCES` = the first three.
- `authority` — **write authority**: `human_authoring`, `human_confirmation`, `derived`.
  `HUMAN_AUTHORITIES` require a real `authoredBy` principal.

`MAX_LEVEL_FOR_AUTHORITY`: human authorities may hold up to `SECRET`; `derived` may hold only `PUBLIC`.
A `derived` authority with a principal is rejected (`derived-with-principal`), and source/authority
contradictions are rejected (`authority-source-conflict`).

An explicit writer cannot create `PUBLIC` (`public-not-creatable-by-explicit-writer`); explicit
authoring is limited to gated levels.

---

## 4. Normalization Rules

- fail closed: a header-only write without a valid `authority` is not a formal fact;
- legacy/absent level ⇒ `UNDETERMINED` (read side);
- `authority` caps the allowed level (`MAX_LEVEL_FOR_AUTHORITY`) — a too-high level is downgraded, not
  silently accepted;
- human authorities require `authoredBy`; `authoredBy` equal to the owner (`user`) is rejected as
  a forged principal.

---

## 5. Non-goals

This contract does not define authorization (see `DISCLOSURE_AUTHORIZATION_CONTRACT.md`), authoring
pipeline (`DISCLOSURE_AUTHORING_CONTRACT.md`), or storage (`DISCLOSURE_STORAGE_CONTRACT.md`).

---

## 6. Enforcement

| Test | Pins |
| --- | --- |
| `tests/test_disclosure_core.js` | fields, levels, writer authority, normalization |

---

## 7. Historical Origin

`assets/js/disclosure-core.js` (Phase 4B-1).
