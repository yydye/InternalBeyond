# Memory Migration Contract

**Status: Canonical**
**Scope: Memory schema migration、content migration 与 export/backup 区分**

> 区分三件绝不可混为一谈的事情的当前状态 contract：
> schema migration、content migration 与 backup export。它不定义 storage authority
>（见 [`MEMORY_AUTHORITY_CONTRACT.md`](MEMORY_AUTHORITY_CONTRACT.md)）。

---

## 1. 三件彼此不同的事

| 概念 | 它是什么 | 谁拥有 |
| --- | --- | --- |
| **Schema migration** | storage structure versioning | storage owner（browser DB / Home Node schema） |
| **Content migration** | 将现有 records 迁移到 canonical authority | client bootstrap + Home Node watermark |
| **Backup export** | browser mirror 的面向用户副本 | browser（用户操作） |

它们不是同一种操作，也不可互换。

---

## 2. Browser Schema

- Owner：browser storage（`assets/js/core.js`），以 `InternalBeyondDB` 打开。
- 当前版本：`DB_VER = 24`。
- 升级路径：`onupgradeneeded`（创建/升级 object stores）。不存在 per-store migration
  framework；新的 Memory 字段由 `payload_json` 承载。

---

## 3. Server Schema

- Owner：`services/home-node/memory-store.js`。
- 当前版本：`MEMORY_SCHEMA_VERSION = 1`，存储在 `meta['memory_schema']`。
- Guard：如果存储的 schema 比 build **更新**，打开会以 `SCHEMA_TOO_NEW` 失败
  （无静默强制转换）。不存在 `ALTER TABLE` migration framework；刻意避免
  column-per-field 设计，因此 `payload_json` 持有每一个字段。

---

## 4. Content Migration

- Trigger：一次性将现有 `memories` 迁移到 canonical Home Node authority（M1-C.2d Wave 2）。
- Mechanism：`memory-authority` migration + client endpoints `/memory/migration`（读取状态）与
  `/memory/migrate`（标记/推进状态）。
- Watermark：`meta['migration:memory:<source>'] = { version, lastTimestamp, records, idSet }`
  (`memory-store.js` `migrationKey` / `getMigrationState` / `setMigrationState`).
- Overwrite policy：一次性 migration 使用 `existingPolicy:'skip'`；正常 runtime 写入使用
  `overwrite`。
- Idempotency：content equivalence（见 `MEMORY_RECORD_CONTRACT.md` §2）使重跑将
  未变更的 records 归类为 `skipped` 而非 `updated`。

---

## 5. Backup Export / Import

- Owner：**browser**（`assets/js/memory.js` `exportMemories` / `importMemoriesFile`）。
- export 是 **browser mirror**，序列化为 JSON。

> 当前 export 是 browser mirror export，**而非** canonical Home Node export。

不得将其呈现为官方 memory backup 或 canonical archive。

---

## 6. Non-goals

本 contract 不实现 migration framework，不改变任何 schema version，也
不使 export 成为 authoritative。

---

## 7. Enforcement

| 测试 | 约束内容 |
| --- | --- |
| `tests/test_memory_migration.js` | 一次性 migration + watermark + idempotency |
| `tests/test_memory_repair_dryrun.js` | provenance repair flow（dry run） |
| `tests/test_home_node_production_memory_assembly.js` | storage assembly / schema |

---

## 8. 历史起源

`docs/HOME_NODE_CHAT.md §15`（M1-C.2d Wave 2）。历史 migration plan 位于 research
workspace（不属于 first-party docs）。
