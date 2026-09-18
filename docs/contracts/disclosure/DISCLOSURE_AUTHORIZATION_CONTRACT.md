# Disclosure Authorization Contract

**Status: Canonical**
**Scope: The formal disclosure authorization decision**

> Current-state contract derived from `assets/js/disclosure-authorization-core.js` and
> `tests/test_disclosure_authorization.js`. The core is pure (no DOM/fetch/IndexedDB/localStorage) and
> **never throws**.

---

## 1. Decision Shape

```
authorize(fact, context, opts?) → {
  allowed, reasonCode,
  recipientCharacterId, factId, ownerCharacterId, level
}
```

`context = { recipientCharacterId, grants? }`.

The core answers only the authorization question. It does not assemble prompts, write traces, read
stores, or consult relationship state.

---

## 2. Dimensions

`ownerCharacterId` · `recipientCharacterId` · `level` · `grants` — **none of these is a relationship
dimension**. `source` / `authority` / `authoredBy` are authoring provenance, not authorization inputs.

---

## 3. DEFAULT DENY

Every missing / invalid / unknown case resolves to DENY. There is **no path to ALLOW** except an
explicit grant.

DENY reason codes include (code-backed): `invalid-fact` (not a fact / missing owner / missing factId /
malformed grant), `level-unknown` (unknown level), `level-not-authorizable`, `recipient-missing`,
`recipient-is-owner`, `invalid-grant`, `no-explicit-grant`, `grant-level-stale`.

---

## 4. Grant Semantics

A grant is **ALLOW-only** (there is no ALLOW/DENY dual state; the default is already DENY):

```
{ grantId?, factId, ownerCharacterId, recipientCharacterId,
  permission, authority, authoredBy?, updatedAt?, levelAtGrant }
```

- binding is **exact**: owner **and** recipient **and** factId **and** `permission === 'disclose'`;
- `authority` must be human (`human_authoring` / `human_confirmation`); a `derived` grant is invalid;
- `levelAtGrant` is **required**; missing/invalid ⇒ DENY `invalid-grant`;
- a grant issued at a level is only valid while the fact's current rank is ≤ `levelAtGrant`, otherwise
  DENY `grant-level-stale`;
- **no wildcard**, **no permission hierarchy** — `PRIVATE` and `SECRET` each require the same explicit
  per-fact recipient grant.

The single ALLOW path is `explicit-grant`.

---

## 5. De-registration Boundary

`trust`, `affinity`, `familiarity`, `dmCount`, `relationship`, `toneCounts`, `initiative`, `intent`,
`memorandum`, and `pairAffinity` are **explicitly excluded** from being grants or ALLOW reasons. Owner
model grants / peer model grants / trust / familiarity / autonomous intent / memorandum / conversation
history / Memory visibility cannot substitute for a grant. There is no
`high affinity → automatically reveal secret`.

These signals may exist elsewhere (e.g. `role-dm-core` projections), but they are **not** formal
disclosure authorization authority.

---

## 6. Failure Posture

`authorize()` wraps its decision in `try/catch`; an unexpected exception returns DENY (never throws to
the caller). Validation (S8) confirms the exception path is not reachable in the current core.

---

## 7. Production Integration Status

The decision is implemented and tested, but **`authorize()` has no production caller** and no
production consumer enforces it. Tests passing `authorize()` do **not** imply a production consumer
exists.

---

## 8. Non-goals

This contract does not define the fact model, authoring, storage, or any integration.

---

## 9. Enforcement

| Test | Pins |
| --- | --- |
| `tests/test_disclosure_authorization.js` | DEFAULT DENY, grant matching, de-registration, never-throw |

---

## 10. Historical Origin

`assets/js/disclosure-authorization-core.js` (Phase 4B-2A); `DECISIONS.md` D31.
