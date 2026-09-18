# Memory Migration Contract

**Status: Canonical**
**Scope: Memory schema migration, content migration, and export/backup distinction**

> Current-state contract that separates three things that must never be conflated:
> schema migration, content migration, and backup export. It does not define storage authority
> (see [`MEMORY_AUTHORITY_CONTRACT.md`](MEMORY_AUTHORITY_CONTRACT.md)).

---

## 1. The Three Distinct Things

| Concept | What it is | Who owns it |
| --- | --- | --- |
| **Schema migration** | storage structure versioning | the storage owner (browser DB / Home Node schema) |
| **Content migration** | moving existing records onto canonical authority | client bootstrap + Home Node watermark |
| **Backup export** | a user-facing copy of the browser mirror | browser (user action) |

These are not the same operation and are not interchangeable.

---

## 2. Browser Schema

- Owner: browser storage (`assets/js/core.js`), opened as `InternalBeyondDB`.
- Current version: `DB_VER = 24`.
- Upgrade path: `onupgradeneeded` (create/upgrade object stores). There is no per-store migration
  framework; new Memory fields are carried in `payload_json`.

---

## 3. Server Schema

- Owner: `services/home-node/memory-store.js`.
- Current version: `MEMORY_SCHEMA_VERSION = 1`, stored in `meta['memory_schema']`.
- Guard: if the stored schema is **newer** than the build, opening fails with `SCHEMA_TOO_NEW`
  (no silent coercion). There is no `ALTER TABLE` migration framework; a column-per-field design is
  intentionally avoided, so `payload_json` holds every field.

---

## 4. Content Migration

- Trigger: one-shot move of existing `memories` onto canonical Home Node authority (M1-C.2d Wave 2).
- Mechanism: `memory-authority` migration + client endpoints `/memory/migration` (read state) and
  `/memory/migrate` (mark/advance state).
- Watermark: `meta['migration:memory:<source>'] = { version, lastTimestamp, records, idSet }`
  (`memory-store.js` `migrationKey` / `getMigrationState` / `setMigrationState`).
- Overwrite policy: the one-shot migration uses `existingPolicy:'skip'`; normal runtime writes use
  `overwrite`.
- Idempotency: content equivalence (see `MEMORY_RECORD_CONTRACT.md` §2) makes a re-run classify
  unchanged records as `skipped` rather than `updated`.

---

## 5. Backup Export / Import

- Owner: **browser** (`assets/js/memory.js` `exportMemories` / `importMemoriesFile`).
- The export is the **browser mirror**, serialized to JSON.

> Current export is browser mirror export, **not** canonical Home Node export.

It must not be presented as an official memory backup or canonical archive.

---

## 6. Non-goals

This contract does not implement a migration framework, does not change either schema version, and
does not make export authoritative.

---

## 7. Enforcement

| Test | What it pins |
| --- | --- |
| `tests/test_memory_migration.js` | one-shot migration + watermark + idempotency |
| `tests/test_memory_repair_dryrun.js` | provenance repair flow (dry run) |
| `tests/test_home_node_production_memory_assembly.js` | storage assembly / schema |

---

## 8. Historical Origin

`docs/HOME_NODE_CHAT.md §15` (M1-C.2d Wave 2). Historical migration plan lives in the research
workspace (excluded from first-party docs).
