# Moments Record Contract

**Status: Canonical**
**Scope: canonical Moment record**

> 派生自 `services/home-node/moments-store.js`（schema + serializers）、
> `assets/js/moments.js` 与 tests 的当前状态 contract。不虚构字段。

---

## 1. 提升列

Home Node `records` 表提升：

| 列 | 含义 |
| --- | --- |
| `record_id` | identity（主键） |
| `author_type` / `author_id` | author identity（默认 `role`；用户帖子为 `user`） |
| `owner_role_id` | owner partition |
| `content` | 文本内容 |
| `visibility` | ACL tier（`all` / `user` / `roles` / `private`） |
| `visible_role_ids` | 用于 `roles` visibility 的 role 列表 |
| `likes` | likes（内嵌、有界） |
| `comment_count` | comment 数量 |
| `source` | 来源 |
| `created_at` / `updated_at` | 时间戳 |
| `record_rev` | per-record revision（CAS） |
| `revision` | 写入时的 store revision |
| `created_rev` | 创建时的 revision |
| `deleted_at` / `deleted_rev` | soft-delete 状态 |
| `payload_json` | **每一个**字段，包括内嵌的 `comments` 与 `images` |

Bounds：`VISIBLE_ROLES_MAX = 20`, `COMMENTS_MAX = 200`, `LIKES_MAX = 1000`。未知字段必须
通过 `payload_json` 原样往返。

---

## 2. Identity / 归属

- `record_id` 是 identity；没有 id 的 record 无效（`invalid-id`）。
- 没有 author identity 的 record 是 `unattributable`（被拒绝）。
- `owner_role_id` 是 partition key；`authorOf()` 解析 author（`user` → `authorId`，
  否则 `roleId`）。

---

## 3. Visibility

`visibility` ∈ {`all`, `user`, `roles`, `private`}；`roles` 使用 `visibleRoleIds`。ACL semantics：
`MOMENTS_ACL_CONTRACT.md`。

---

## 4. Revision / 删除

- `record_rev` 在 update 时驱动 CAS；`revision` 是写入时的 store revision。
- Delete 是 **soft** 的（`deleted_at` / `deleted_rev`）；实时读取过滤 `deleted_at IS NULL`。
- `change_log` 为 cursor sync 按 revision 记录 `kind` + `record_id`。

---

## 5. Non-goals

本 contract 不定义 ACL policy、sync protocol 或 image pipeline。它不添加字段。

---

## 6. Enforcement

| 测试 | 约束内容 |
| --- | --- |
| `tests/test_moments_authority.js` | record validation / CAS / soft delete |
| `tests/test_p11_3e_moments_mutations.js` | mutation semantics |
| `tests/test_moments_acl_contract.js` | visibility fields |

---

## 7. 历史起源

`services/home-node/moments-store.js` (M1-C.2n).
