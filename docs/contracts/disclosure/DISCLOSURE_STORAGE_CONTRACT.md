# Disclosure Storage Contract

**Status: Canonical**
**Scope: Disclosure fact storage surface**

> 当前状态 Contract，派生自 `assets/js/disclosure-store.js`、`assets/js/core.js`
> （`disclosureFacts` store、`DB_VER 24`），以及 `tests/test_disclosure_store_smoke.js`。

---

## 1. Storage

| Aspect | Value |
| --- | --- |
| Database | `InternalBeyondDB` (`DB_VER 24`) |
| Store | `disclosureFacts` |
| Key | `factId` |
| Scope | **browser-local persisted store** |

除 store record 本身外，没有 schema migration、revision、cursor 或 lifecycle。

---

## 2. CRUD Surface

`disclosure-store.js` 暴露 `createFact(writerContext, userInput)`（`factId` 在 store
层生成）、`listFacts(ownerCharacterId)`（按 `ownerCharacterId` 分区）、`updateFact`、`deleteFact`。
IO 是注入的（`dbPut` / `dbGet` / `dbGetAll` / `dbDelete`）。

store 是 **CRUD-only**，并且刻意不持有**任何 decision logic**。

---

## 3. Storage ≠ Decision Authority

```
disclosure-store.js  =  CRUD storage surface
disclosure-authorization-core.js  =  authorization authority
```

持久化 facts 不会使 store 成为 Disclosure authority owner。

---

## 4. 无 Home Node Authority

已验证：**没有 Home Node disclosure table、没有 revision、没有 cursor、没有 Home Node
migration**，也**没有 `canonical` / `mirror` / `off` authority mode**。Disclosure 不使用
Memory/Moments authority pattern。

---

## 5. Export 边界

`disclosureFacts` 被**排除**在 `_ibBuildExportData` 之外（位于 `core.js`）。

> Disclosure facts 持久化在 browser-local，但被排除在当前 general export surface 之外。

仅陈述事实；本 Contract 不评估也不改变 export behavior。

---

## 6. Non-goals

本 Contract 不定义 fact model、authoring 或 authorization。它不设计 sync、
migration 或 Home Node authority。

---

## 7. Enforcement

| Test | 固定内容 |
| --- | --- |
| `tests/test_disclosure_store_smoke.js` | real-browser write path（需要 Chrome/Edge） |

---

## 8. 历史来源

`assets/js/disclosure-store.js`；`DB_VER 24` 新增 `disclosureFacts`。
