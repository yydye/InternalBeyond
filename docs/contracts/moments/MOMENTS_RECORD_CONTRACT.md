# Moments Record Contract

**Status: Canonical**
**Scope: The canonical Moment record**

> Current-state contract derived from `services/home-node/moments-store.js` (schema + serializers),
> `assets/js/moments.js`, and tests. No invented fields.

---

## 1. Promoted Columns

The Home Node `records` table promotes:

| Column | Meaning |
| --- | --- |
| `record_id` | identity (primary key) |
| `author_type` / `author_id` | author identity (`role` default; `user` for user posts) |
| `owner_role_id` | owner partition |
| `content` | text content |
| `visibility` | ACL tier (`all` / `user` / `roles` / `private`) |
| `visible_role_ids` | role list for `roles` visibility |
| `likes` | likes (embedded, bounded) |
| `comment_count` | comment count |
| `source` | origin |
| `created_at` / `updated_at` | timestamps |
| `record_rev` | per-record revision (CAS) |
| `revision` | store revision at write |
| `created_rev` | revision at creation |
| `deleted_at` / `deleted_rev` | soft-delete state |
| `payload_json` | **every** field, including embedded `comments` and `images` |

Bounds: `VISIBLE_ROLES_MAX = 20`, `COMMENTS_MAX = 200`, `LIKES_MAX = 1000`. Unknown fields must
round-trip through `payload_json`.

---

## 2. Identity / Ownership

- `record_id` is the identity; a record without an id is invalid (`invalid-id`).
- A record without an author identity is `unattributable` (rejected).
- `owner_role_id` is the partition key; `authorOf()` resolves the author (`user` → `authorId`,
  otherwise `roleId`).

---

## 3. Visibility

`visibility` ∈ {`all`, `user`, `roles`, `private`}; `roles` uses `visibleRoleIds`. ACL semantics:
`MOMENTS_ACL_CONTRACT.md`.

---

## 4. Revision / Deletion

- `record_rev` drives CAS on update; `revision` is the store revision at write time.
- Delete is **soft** (`deleted_at` / `deleted_rev`); live reads filter `deleted_at IS NULL`.
- `change_log` records `kind` + `record_id` per revision for cursor sync.

---

## 5. Non-goals

This contract does not define ACL policy, sync protocol, or the image pipeline. It does not add fields.

---

## 6. Enforcement

| Test | Pins |
| --- | --- |
| `tests/test_moments_authority.js` | record validation / CAS / soft delete |
| `tests/test_p11_3e_moments_mutations.js` | mutation semantics |
| `tests/test_moments_acl_contract.js` | visibility fields |

---

## 7. Historical Origin

`services/home-node/moments-store.js` (M1-C.2n).
