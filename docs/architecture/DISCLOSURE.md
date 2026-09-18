# Disclosure Architecture

**Status: Canonical**
**Scope: Current Disclosure Architecture and Authority**

**Production Integration: PROVISIONAL / NOT WIRED** — the authorization decision is implemented and
tested, but **not currently enforced by a production consumer**. Canonical authority completeness and
production integration completeness are **different dimensions**; this document records both.

> Source-of-truth priority: production code → targeted tests → contracts → D9-0 audit → current
> canonical docs / `DECISIONS.md` → history. Where this document conflicts with current code, code wins.

---

## 1. Definition

> Disclosure is the authority subsystem that determines whether a **character-authored fact** may be
> revealed to a specific **recipient character** under the formal disclosure policy.

Core question: **Who can know what?**

It is **not**: Relationship, Moments ACL, Memory visibility, Companion, Middle Brain, Voice, or a
Social authority. It is an authorization subsystem, not a background runtime.

---

## 2. Architecture Layers

```
Fact Model            assets/js/disclosure-core.js
    │
    ▼
Authoring             assets/js/disclosure-authoring-core.js
    │
    ▼
Storage               assets/js/disclosure-store.js
    │
    ▼
Authorization         assets/js/disclosure-authorization-core.js
```

There is **no fifth runtime layer** and no background process.

---

## 3. Fact Model

A fact has: `factId`, `ownerCharacterId`, `level`, `text`, `subjectCharacterId` (empty = about the
character themself), `source`, `authority`, `authoredBy`, `updatedAt`. Levels are `PUBLIC`, `PERSONAL`,
`PRIVATE`, `SECRET` (+ read-side `UNDETERMINED`).
Full contract: [`../contracts/disclosure/DISCLOSURE_FACT_CONTRACT.md`](../contracts/disclosure/DISCLOSURE_FACT_CONTRACT.md).

---

## 4. Writer Authority & Authoring

- `source` = **provenance** (which channel produced the data); `authority` = **write authority** (who
  vouches it is the character's true setting); `authoredBy` = the human principal.
- `HUMAN_AUTHORITIES` (`human_authoring` / `human_confirmation`) require an `authoredBy` principal;
  `derived` authority is capped at `PUBLIC` and cannot hold a principal.
- The authoring path (`disclosure-authoring-core.js`) supplies owner/source/authority from **writer
  context**, never from untrusted client input; explicit authoring can only create **gated** levels
  (`PERSONAL` / `PRIVATE` / `SECRET`) — not `PUBLIC`.
- Production authoring surface found: `assets/js/social.js` (authoring/control surface).

Contracts: [`../contracts/disclosure/DISCLOSURE_AUTHORING_CONTRACT.md`](../contracts/disclosure/DISCLOSURE_AUTHORING_CONTRACT.md).

> **Fact exists ≠ Recipient is authorized. Fact authored ≠ Fact disclosed.**

---

## 5. Storage

`disclosureFacts` is a **browser-local IndexedDB store** (`InternalBeyondDB`, `DB_VER 24`, key
`factId`), CRUD-only. There is **no Home Node disclosure table, no revision, no cursor, no migration**,
and **no `canonical`/`mirror`/`off` authority mode**.

> Storage CRUD is **not** the authorization authority. The decision authority is
> `disclosure-authorization-core.js`.

`disclosureFacts` is excluded from the current general export surface (`_ibBuildExportData`).
Contract: [`../contracts/disclosure/DISCLOSURE_STORAGE_CONTRACT.md`](../contracts/disclosure/DISCLOSURE_STORAGE_CONTRACT.md).

---

## 6. Authorization Decision

```
authorize(fact, context) → { allowed, reasonCode, factId, ownerCharacterId, level, … }
  context = { recipientCharacterId, grants? }
```

The core is pure (no DOM/fetch/IndexedDB/localStorage), **never throws**, and answers only the
authorization question — it does not assemble prompts or write traces. Contract:
[`../contracts/disclosure/DISCLOSURE_AUTHORIZATION_CONTRACT.md`](../contracts/disclosure/DISCLOSURE_AUTHORIZATION_CONTRACT.md).

---

## 7. DEFAULT DENY

The only formal ALLOW path is an **explicit grant** `(factId, recipientCharacterId)`. Every missing /
invalid / unknown case resolves to DENY. A grant binds owner + recipient + factId + permission
(`disclose`) + authority (human only) + `levelAtGrant`; there is no wildcard and no permission
hierarchy.

---

## 8. De-registration Boundary

`relationship`, `trust`, `affinity`, `familiarity`, `dmCount`, `toneCounts`, `initiative`, `intent`,
`memorandum`, and `pairAffinity` **may exist elsewhere**, but they are **not** formal disclosure
authorization authority. There is no `high affinity → automatically reveal secret` path. The
authorization core explicitly de-registers these behavioral/relationship signals.

---

## 9. Production Integration Status

Verified against current production code:

- **`authorize()` has no production caller** (only tests).
- **Role DM composition is not gated by disclosure authorization** (`role-dm.js` / `role-dm-core.js`
  contain 0 disclosure references).
- Moments, Companion, Middle Brain, Memory, Voice, Letters contain **0** disclosure references.

> The authorization decision is implemented and tested, but is not currently enforced by a production
> consumer.

This is a **documentation/authority** canonicalization, not an integration change. It is not authority
fragmentation or conflict.

---

## 10. Boundaries

| Surface | Boundary |
| --- | --- |
| Relationship | `cfg.relationship` is the relationship authority; Relationship ≠ Disclosure ([`COMPANION.md`](COMPANION.md), [`RELATIONSHIP_AUTHORITY_CONTRACT.md`](../contracts/companion/RELATIONSHIP_AUTHORITY_CONTRACT.md)) |
| PairAffinity | derived/ephemeral interaction weighting; not disclosure authority |
| Moments | Moments visibility/`visibleRoleIds` is the Moments ACL; Moments ACL ≠ Disclosure; no production integration ([`MOMENTS.md`](MOMENTS.md), [`MOMENTS_ACL_CONTRACT.md`](../contracts/moments/MOMENTS_ACL_CONTRACT.md)) |
| Memory | Memory content ≠ disclosure permission; no ownership either way ([`MEMORY.md`](MEMORY.md)) |
| Companion | Companion ≠ Disclosure authority; no references in active runtime ([`COMPANION.md`](COMPANION.md)) |
| Middle Brain | MB does not enforce Disclosure; context selection ≠ fact disclosure authorization ([`MIDDLE_BRAIN.md`](MIDDLE_BRAIN.md)) |
| Voice | Voice is outside the current Disclosure path ([`VOICE.md`](VOICE.md)) |
| Role DM | intended consumer boundary, **NOT CURRENTLY ENFORCED** |
| Letters (user↔character, AI↔AI) | no current Disclosure integration |
| Public Profile | `PUBLIC` profile information is owned by `publicProfileCore`, **not** formal disclosure; Public Profile ≠ Formal Disclosure |

---

## 11. UI Boundary

The current production authoring surface is the Social UI — an **authoring/control surface**, not the
Disclosure authority. Social does not own Disclosure.

---

## 12. Non-goals

This document does not define a runtime, sync, migration, Home Node authority, or any integration. It
does not modify DEFAULT DENY or grant semantics.

---

## 13. Enforcement

| Concern | Tests |
| --- | --- |
| Fact contract | `tests/test_disclosure_core.js` |
| Authoring | `tests/test_disclosure_authoring.js` |
| Authorization | `tests/test_disclosure_authorization.js` |
| Storage (browser smoke) | `tests/test_disclosure_store_smoke.js` |

Tests passing `authorize()` does **not** imply a production consumer exists.

---

## 14. Historical References

`DECISIONS.md` **D30** (formal fact-writer path) and **D31** (authorization is formal, not
relationship) are decision provenance. Current authority is this document +
`../contracts/disclosure/`.
