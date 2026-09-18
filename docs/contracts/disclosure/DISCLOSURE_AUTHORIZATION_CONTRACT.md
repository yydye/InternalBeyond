# Disclosure Authorization Contract

**Status: Canonical**
**Scope: 正式 disclosure authorization decision**

> 当前状态 Contract，派生自 `assets/js/disclosure-authorization-core.js` 与
> `tests/test_disclosure_authorization.js`。core 是纯的（无 DOM/fetch/IndexedDB/localStorage）且
> **never throws**。

---

## 1. Decision 形态

```
authorize(fact, context, opts?) → {
  allowed, reasonCode,
  recipientCharacterId, factId, ownerCharacterId, level
}
```

`context = { recipientCharacterId, grants? }`。

core 只回答 authorization 问题。它不组装 prompts、不写 traces、不读取 stores，也不查询
relationship state。

---

## 2. 维度

`ownerCharacterId` · `recipientCharacterId` · `level` · `grants` —— **这些都不是 relationship
dimension**。`source` / `authority` / `authoredBy` 是 authoring provenance，不是 authorization inputs。

---

## 3. DEFAULT DENY

每一个缺失 / 无效 / 未知的情况都会解析为 DENY。除了显式 grant 之外，**不存在通往 ALLOW 的路径**。

DENY reason codes 包括（由代码支持）：`invalid-fact`（不是 fact / 缺少 owner / 缺少 factId /
malformed grant）、`level-unknown`（未知 level）、`level-not-authorizable`、`recipient-missing`、
`recipient-is-owner`、`invalid-grant`、`no-explicit-grant`、`grant-level-stale`。

---

## 4. Grant 语义

grant 是 **ALLOW-only**（不存在 ALLOW/DENY 双态；默认已经是 DENY）：

```
{ grantId?, factId, ownerCharacterId, recipientCharacterId,
  permission, authority, authoredBy?, updatedAt?, levelAtGrant }
```

- 绑定是 **exact**：owner **and** recipient **and** factId **and** `permission === 'disclose'`；
- `authority` 必须是 human（`human_authoring` / `human_confirmation`）；`derived` grant 无效；
- `levelAtGrant` 是**必填**；缺失/无效 ⇒ DENY `invalid-grant`；
- 按某个 level 颁发的 grant 仅在 fact 当前 rank ≤ `levelAtGrant` 时有效，否则
  DENY `grant-level-stale`；
- **无 wildcard**、**无 permission hierarchy** —— `PRIVATE` 与 `SECRET` 各自都需要相同的、针对每个
  fact 的显式 recipient grant。

唯一的 ALLOW 路径是 `explicit-grant`。

---

## 5. De-registration 边界

`trust`、`affinity`、`familiarity`、`dmCount`、`relationship`、`toneCounts`、`initiative`、`intent`、
`memorandum` 与 `pairAffinity` 被**明确排除**在 grants 或 ALLOW reasons 之外。Owner
model grants / peer model grants / trust / familiarity / autonomous intent / memorandum / conversation
history / Memory visibility 都不能替代 grant。不存在
`high affinity → automatically reveal secret`。

这些 signals 可能存在于别处（例如 `role-dm-core` projections），但它们**不是**正式
disclosure authorization authority。

---

## 6. 失败姿态

`authorize()` 将其 decision 包在 `try/catch` 中；意外异常会返回 DENY（绝不向
caller 抛出）。Validation (S8) 确认在当前 core 中该异常路径不可达。

---

## 7. Production Integration Status

该 decision 已实现并测试，但 **`authorize()` 没有 production caller**，也没有
production consumer 强制执行它。测试通过 `authorize()` **并不**意味着存在 production
consumer。

---

## 8. Non-goals

本 Contract 不定义 fact model、authoring、storage 或任何 integration。

---

## 9. Enforcement

| Test | 固定内容 |
| --- | --- |
| `tests/test_disclosure_authorization.js` | DEFAULT DENY、grant matching、de-registration、never-throw |

---

## 10. 历史来源

`assets/js/disclosure-authorization-core.js`（Phase 4B-2A）；`DECISIONS.md` D31。
