# Moments ACL Contract

**Status: Canonical**
**Scope: Moment visibility / access control**

> Current-state contract. Source: `assets/js/moments-visibility-core.js` (UMD, shared browser + Node),
> `tests/test_moments_acl_contract.js`. This contract covers **visibility only**; disclosure
> authorization is a separate subsystem.

---

## 1. Visibility ≠ Disclosure Authorization

```
Moments visibility (ACL)   ≠   disclosureFacts (disclosure authorization)
```

`disclosureFacts` belongs to the disclosure subsystem and is **not** the Moments ACL. Do not merge them.

---

## 2. Tiers

`VISIBILITIES = ['all', 'user', 'roles', 'private']` (+ read-side `invalid`).

| Tier | Meaning |
| --- | --- |
| `all` | visible to everyone |
| `user` | visible to the user |
| `roles` | visible to listed `visibleRoleIds` |
| `private` | author only |
| `invalid` | read-side sentinel: missing / malformed / unknown → author-only |

---

## 3. Read vs Write Side

- **Read side (`readVisibility`, fail closed)**: missing (`undefined`/`null`/`''`), non-string, or
  unknown → `invalid` → not visible (except author). Missing ACL must never become public.
- **Write side (`writeVisibility`, product default)**: missing → `all`; valid → as-is; present but
  invalid → `invalid` (**never** fall back to `all`).

So a model's malformed tier **narrows** visibility rather than widening it.

---

## 4. The Single Predicate

`isMomentVisibleTo(moment, principal)` is the one predicate. Callers must filter with it **before**
sort / slice / top-k / paging, and it must also cover by-id direct reads.

Base rejections (before any tier logic): undeterminable principal (missing kind/id) → false;
undeterminable id → false (a missing field must not masquerade as a policy).

Author rule: the author can always read their own moment (including `private` / `invalid`); a user
principal can always read user-authored posts.

`filterVisibleMoments(list, principal)` is the list entry (non-array → `[]`, fail closed).

---

## 5. Child Artifacts

`comments` / `likes` are embedded in the moment row and have **no independent ACL** — their visibility
**is** the moment's visibility. `deriveChildVisibility(sources)` (strictest-wins) is used when a child
is derived from several sources: empty → `private`; any `private`/`invalid` → `private`; all `all` →
`all`; otherwise `roles` with the intersection of `visibleRoleIds`.

---

## 6. Authority

| Concern | Authority |
| --- | --- |
| owner | Moments (`owner_role_id` / `authorOf`) |
| audience | Moments (`visibility`) |
| visibleRoleIds | Moments (`visible_role_ids`) |
| filtering | Moments visibility core + Home Node promoted columns |
| repair | Moments (write-side normalization) |
| authorization (disclosure) | **Disclosure subsystem** (separate, not Moments ACL) |

---

## 7. Non-goals

This contract does not define disclosure authorization, relationship, or memory visibility.

---

## 8. Enforcement

| Test | Pins |
| --- | --- |
| `tests/test_moments_acl_contract.js` | tiers, read/write sides, predicate, child derivation |
| `tests/test_p11_3e_moments_mutations.js` | visibility on mutation |

---

## 9. Historical Origin

`assets/js/moments-visibility-core.js` (M1-C.2n P0).
