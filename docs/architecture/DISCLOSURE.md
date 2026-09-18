# Disclosure 架构

**Status: Canonical**
**Scope: 当前 Disclosure 架构与 Authority**

**Production Integration: PROVISIONAL / NOT WIRED** — authorization decision 已实现并
测试，但**当前未被 production consumer 强制执行**。Canonical authority 完整性与
production integration 完整性是**不同的维度**；本文档记录两者。

> Source-of-truth 优先级：production code → targeted tests → contracts → D9-0 audit → current
> canonical docs / `DECISIONS.md` → history。当本文档与当前 code 冲突时，以 code 为准。

---

## 1. 定义

> Disclosure 是 authority 子系统，负责根据正式 disclosure policy 判定一个 **character-authored fact**
> 是否可以揭示给特定的 **recipient character**。

核心问题：**谁可以知道什么？**

它**不是**：Relationship、Moments ACL、Memory visibility、Companion、Middle Brain、Voice，或
Social authority。它是授权子系统，不是后台 runtime。

---

## 2. 架构层级

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

**不存在第五个 runtime 层**，也不存在后台进程。

---

## 3. Fact Model

一个 fact 有：`factId`、`ownerCharacterId`、`level`、`text`、`subjectCharacterId`（留空 = 关于该
character 自身）、`source`、`authority`、`authoredBy`、`updatedAt`。Level 为 `PUBLIC`、`PERSONAL`、
`PRIVATE`、`SECRET`（+ 读取侧的 `UNDETERMINED`）。
完整 contract：[`../contracts/disclosure/DISCLOSURE_FACT_CONTRACT.md`](../contracts/disclosure/DISCLOSURE_FACT_CONTRACT.md)。

---

## 4. Writer Authority 与 Authoring

- `source` = **provenance**（哪个 channel 产生了数据）；`authority` = **write authority**（谁
  担保它是该 character 的真实设定）；`authoredBy` = human principal。
- `HUMAN_AUTHORITIES`（`human_authoring` / `human_confirmation`）要求有 `authoredBy` principal；
  `derived` authority 上限为 `PUBLIC`，且不能持有 principal。
- authoring path（`disclosure-authoring-core.js`）从 **writer
  context** 提供 owner/source/authority，绝不从不受信任的 client input 提供；显式 authoring 只能创建 **gated** levels
  （`PERSONAL` / `PRIVATE` / `SECRET`）— 而非 `PUBLIC`。
- 发现的生产 authoring surface：`assets/js/social.js`（authoring/control surface）。

Contracts：[`../contracts/disclosure/DISCLOSURE_AUTHORING_CONTRACT.md`](../contracts/disclosure/DISCLOSURE_AUTHORING_CONTRACT.md)。

> **Fact 存在 ≠ Recipient 已授权。Fact 已 author ≠ Fact 已 disclose。**

---

## 5. Storage

`disclosureFacts` 是一个 **browser-local IndexedDB store**（`InternalBeyondDB`、`DB_VER 24`、key
`factId`），仅 CRUD。**不存在 Home Node disclosure table、没有 revision、没有 cursor、没有 migration**，
也**没有 `canonical`/`mirror`/`off` authority mode**。

> Storage CRUD **不是** authorization authority。decision authority 是
> `disclosure-authorization-core.js`。

`disclosureFacts` 被排除在当前通用 export surface（`_ibBuildExportData`）之外。
Contract：[`../contracts/disclosure/DISCLOSURE_STORAGE_CONTRACT.md`](../contracts/disclosure/DISCLOSURE_STORAGE_CONTRACT.md)。

---

## 6. Authorization Decision

```
authorize(fact, context) → { allowed, reasonCode, factId, ownerCharacterId, level, … }
  context = { recipientCharacterId, grants? }
```

该 core 是纯的（无 DOM/fetch/IndexedDB/localStorage），**从不抛出异常**，且只回答
authorization 问题 — 它不组装 prompts 也不写 traces。Contract：
[`../contracts/disclosure/DISCLOSURE_AUTHORIZATION_CONTRACT.md`](../contracts/disclosure/DISCLOSURE_AUTHORIZATION_CONTRACT.md)。

---

## 7. DEFAULT DENY

唯一正式的 ALLOW 路径是 **explicit grant** `(factId, recipientCharacterId)`。每个缺失 /
无效 / 未知的情况都解析为 DENY。一个 grant 绑定 owner + recipient + factId + permission
（`disclose`）+ authority（仅 human）+ `levelAtGrant`；没有 wildcard，也没有 permission
hierarchy。

---

## 8. De-registration 边界

`relationship`、`trust`、`affinity`、`familiarity`、`dmCount`、`toneCounts`、`initiative`、`intent`、
`memorandum` 和 `pairAffinity` **可能存在于别处**，但它们**不是**正式 disclosure
authorization authority。不存在 `high affinity → automatically reveal secret` 路径。
authorization core 显式注销这些 behavioral/relationship signals。

---

## 9. Production Integration 状态

已针对当前 production code 验证：

- **`authorize()` 没有 production caller**（仅 tests）。
- **Role DM composition 不受 disclosure authorization 门控**（`role-dm.js` / `role-dm-core.js`
  包含 0 个 disclosure 引用）。
- Moments、Companion、Middle Brain、Memory、Voice、Letters 包含 **0** 个 disclosure 引用。

> authorization decision 已实现并测试，但当前未被 production
> consumer 强制执行。

这是一次 **documentation/authority** canonicalization，不是 integration change。它不是 authority
fragmentation 或 conflict。

---

## 10. 边界

| Surface | 边界 |
| --- | --- |
| Relationship | `cfg.relationship` 是 relationship authority；Relationship ≠ Disclosure（[`COMPANION.md`](COMPANION.md)、[`RELATIONSHIP_AUTHORITY_CONTRACT.md`](../contracts/companion/RELATIONSHIP_AUTHORITY_CONTRACT.md)） |
| PairAffinity | derived/ephemeral interaction weighting；不是 disclosure authority |
| Moments | Moments visibility/`visibleRoleIds` 是 Moments ACL；Moments ACL ≠ Disclosure；无 production integration（[`MOMENTS.md`](MOMENTS.md)、[`MOMENTS_ACL_CONTRACT.md`](../contracts/moments/MOMENTS_ACL_CONTRACT.md)） |
| Memory | Memory content ≠ disclosure permission；双向都不拥有（[`MEMORY.md`](MEMORY.md)） |
| Companion | Companion ≠ Disclosure authority；active runtime 中无引用（[`COMPANION.md`](COMPANION.md)） |
| Middle Brain | MB 不强制执行 Disclosure；context selection ≠ fact disclosure authorization（[`MIDDLE_BRAIN.md`](MIDDLE_BRAIN.md)） |
| Voice | Voice 在当前 Disclosure path 之外（[`VOICE.md`](VOICE.md)） |
| Role DM | 预期的 consumer boundary，**NOT CURRENTLY ENFORCED** |
| Letters (user↔character, AI↔AI) | 当前无 Disclosure integration |
| Public Profile | `PUBLIC` profile information 由 `publicProfileCore` 拥有，**不是**正式 disclosure；Public Profile ≠ Formal Disclosure |

---

## 11. UI 边界

当前 production authoring surface 是 Social UI — 一个 **authoring/control surface**，不是
Disclosure authority。Social 不拥有 Disclosure。

---

## 12. Non-goals

本文档不定义 runtime、sync、migration、Home Node authority 或任何 integration。它
不修改 DEFAULT DENY 或 grant semantics。

---

## 13. Enforcement

| 关注点 | Tests |
| --- | --- |
| Fact contract | `tests/test_disclosure_core.js` |
| Authoring | `tests/test_disclosure_authoring.js` |
| Authorization | `tests/test_disclosure_authorization.js` |
| Storage（browser smoke） | `tests/test_disclosure_store_smoke.js` |

Tests 通过 `authorize()` **并不**意味着存在 production consumer。

---

## 14. 历史引用

`DECISIONS.md` **D30**（正式 fact-writer path）和 **D31**（authorization is formal, not
relationship）是 decision provenance。当前 authority 是本文档 +
`../contracts/disclosure/`。
