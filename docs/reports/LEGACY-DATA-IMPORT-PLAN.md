# LEGACY DATA IMPORT PLAN

Generated: 2026-09-26  
Status: `READY_FOR_LEGACY_DATA_IMPORT`  
Scope: read-only re-planning only. No apply, no new recovery framework, no checkpoint/approval state machine.

## Result

A fresh **missing-only** legacy import plan was produced from the existing recovery sources. Nothing was written. The current Home Node `messages` rows created by the runtime smoke are preserved (INSERT-only; no UPDATE/DELETE; no rollback to the old snapshot). The old frozen WriteSet A / C3.5 artifacts were left untouched and are treated as historical evidence, not as an apply contract.

## 1. Record-body source provenance

Bodies are read directly from the recovery backups whose SHA-256 match the recorded recovery sources. **No body is inferred from frozen metadata.**

| Source file | SHA-256 | Supplies |
|---|---|---|
| `InternalBeyond_auto_2026-09-02.json` (45,062,434 B) | `1170f2a805f25ce2e151b880858e0ab1fdd2aad61281a16754da08a843238401` (= `sourcePrimarySha256`) | `messages` (341), `moments` (155), `memory_records` (3 of 4) |
| `InternalBeyond_auto_2026-08-27.json` (6,263,200 B) | `5963c2d3957b4c1aaf1dba26e1ab94561998d2ac18566e0e51c378d404d4bd84` (= `supplementalMemorySourceSha256`) | `memory_records` (`mem_msgemsdp_l4lj76`, 1 of 4) |
| `IB_backup_2026-09-03.json` | `37f45afe4c4477931dd475ec8be3816e75133bc361a6b471b088be7d70ed198d` (= `supplementalRoleSourceSha256`) | **not used** (roles/characters are out of scope) |

The frozen WriteSet A's 500 stable keys all resolve into these backups (341/341 messages, 155/155 moments, 4/4 memories), which is how the source set was selected.

## 2. Current Home Node target (read-only)

| Table | Rows now | Notes |
|---|---|---|
| `messages` | **4** | this session's runtime-smoke rows (`msg_1790…`); legitimate current data |
| `memory_records` | **0** | |
| `moment_records` | **0** | |

## 3. Set comparison (stable identity: `id` / `record_id`)

| Domain | Source | Target | ALREADY_PRESENT | MISSING | CONFLICTING | INVALID |
|---|---:|---:|---:|---:|---:|---:|
| messages | 341 | 4 | 0 | **341** | 0 | 0 |
| memory_records | 4 | 0 | 0 | **4** | 0 | 0 |
| moment_records | 155 | 0 | 0 | **155** | 0 | 0 |
| **total** | **500** | 4 | 0 | **500** | **0** | **0** |

- No stable id is shared between the source set and the target, so there is no `ALREADY_PRESENT` and no `CONFLICTING` (same id, different content).
- The 4 target `messages` rows are **not** part of the source set and are left untouched.
- One source message (`msg_1785687274674_u`) has empty text `content` but carries an image attachment (`images:[…]`); it is a valid record, not INVALID.

## 4. Import plan (machine-readable: `tmp/legacy-data-import-plan.json`)

```
operations: { INSERT: 500, UPDATE: 0, DELETE: 0 }
messages:       341  <- InternalBeyond_auto_2026-09-02.json#chatMessages
memory_records:   4  <- 3x InternalBeyond_auto_2026-09-02.json#memories + 1x InternalBeyond_auto_2026-08-27.json#memories
moment_records: 155  <- InternalBeyond_auto_2026-09-02.json#moments
```

Per record the plan carries: `stableKey`, `source` (file#collection), `sourceRecordDigest` (sha256 of the source body), and the frozen `fusedRecordSha256` for cross-reference. **No record bodies, image data, or secrets are embedded** (verified: 0 occurrences of `dataUrl`/`base64`/`content`).

Apply semantics for the future authorized import: INSERT-missing-only, using the existing Home Node migration contract (`chat-store.putMessages` / `memory-store.putRecords` with `existingPolicy=skip`; `moments-store.writeMigrated` skips existing stable IDs) with duplicate protection and post-insert readback. `UPDATE`/`DELETE` remain 0.

## 5. Explicitly excluded

`characters.dto_json` / WriteSet B · `character_runtime_specs` / `spec_json` (R3-D) · Active rearm · credentials · Vault · provider config. The old C3.5 sidecar blocker was **not** touched — it did not block read-only access to the source or the target.

## 6. Constraints honored

- Read-only: no INSERT/UPDATE/DELETE executed; Home Node DB and all source files unchanged (target DB read via read-only SQLite handle).
- No modification of the frozen artifacts; no new recovery/approval/checkpoint machinery.
- Sources read only from the existing recovery backups (hashes verified), never fabricated from frozen metadata.
- Runtime-smoke messages preserved: no delete, no overwrite, no snapshot rollback.

## Final status

`READY_FOR_LEGACY_DATA_IMPORT` — 500 missing-only records identified with verified body provenance; 0 conflicting; 0 invalid. Stopping here; the import was not executed.
