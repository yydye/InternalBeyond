# Moments ACL Contract

**Status: Canonical**
**Scope: Moment visibility / access control**

> 当前状态 contract。来源：`assets/js/moments-visibility-core.js`（UMD，browser + Node 共享）、
> `tests/test_moments_acl_contract.js`。本 contract 仅覆盖 **visibility**；disclosure
> authorization 是独立的 subsystem。

---

## 1. Visibility ≠ Disclosure Authorization

```
Moments visibility (ACL)   ≠   disclosureFacts (disclosure authorization)
```

`disclosureFacts` 属于 disclosure subsystem，**不是** Moments ACL。不要合并它们。

---

## 2. 层级

`VISIBILITIES = ['all', 'user', 'roles', 'private']`（+ read-side `invalid`）。

| Tier | 含义 |
| --- | --- |
| `all` | 对所有人可见 |
| `user` | 对 user 可见 |
| `roles` | 对列出的 `visibleRoleIds` 可见 |
| `private` | 仅 author |
| `invalid` | read-side sentinel：缺失 / 格式错误 / 未知 → 仅 author |

---

## 3. Read 侧与 Write 侧

- **Read side（`readVisibility`，fail closed）**：缺失（`undefined`/`null`/`''`）、非字符串或
  未知 → `invalid` → 不可见（author 除外）。缺失的 ACL 绝不能变成 public。
- **Write side（`writeVisibility`，product default）**：缺失 → `all`；有效 → 原样；存在但
  无效 → `invalid`（**绝不**回退到 `all`）。

因此模型给出格式错误的 tier 会**收窄** visibility，而不是放宽它。

---

## 4. 单一谓词

`isMomentVisibleTo(moment, principal)` 是唯一的谓词。调用方必须在
sort / slice / top-k / paging **之前**用它过滤，它还必须覆盖 by-id 直接读取。

基础拒绝（先于任何 tier 逻辑）：无法确定的 principal（缺失 kind/id）→ false；
无法确定的 id → false（缺失字段不得伪装成 policy）。

Author 规则：author 始终可以读取自己的 moment（包括 `private` / `invalid`）；user
principal 始终可以读取 user-authored posts。

`filterVisibleMoments(list, principal)` 是列表入口（非数组 → `[]`，fail closed）。

---

## 5. 子产物

`comments` / `likes` 内嵌于 moment row，**没有独立的 ACL**——它们的 visibility
**就是** moment 的 visibility。当 child 由多个 source 派生时，使用
`deriveChildVisibility(sources)`（strictest-wins）：空 → `private`；存在任何 `private`/`invalid` → `private`；全部 `all` →
`all`；否则为带 `visibleRoleIds` 交集的 `roles`。

---

## 6. Authority

| 关注点 | Authority |
| --- | --- |
| owner | Moments（`owner_role_id` / `authorOf`） |
| audience | Moments（`visibility`） |
| visibleRoleIds | Moments（`visible_role_ids`） |
| filtering | Moments visibility core + Home Node promoted columns |
| repair | Moments（write-side normalization） |
| authorization (disclosure) | **Disclosure subsystem**（独立，非 Moments ACL） |

---

## 7. Non-goals

本 contract 不定义 disclosure authorization、relationship 或 memory visibility。

---

## 8. Enforcement

| 测试 | 约束内容 |
| --- | --- |
| `tests/test_moments_acl_contract.js` | tiers、read/write sides、predicate、child derivation |
| `tests/test_p11_3e_moments_mutations.js` | mutation 时的 visibility |

---

## 9. 历史起源

`assets/js/moments-visibility-core.js` (M1-C.2n P0).
