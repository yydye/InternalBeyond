# LEGACY DATA IMPORT RESULT

Generated: 2026-09-26  
Status: `LEGACY_DATA_IMPORT_COMPLETE`

## Summary

A single missing-only import was executed against the canonical Home Node database using the existing store migration contracts (`chat-store.putMessages`, `memory-store.putRecords`, `moments-store.writeMigrated`) with `existingPolicy=skip` and per-batch transactions. **500 records inserted**, 0 updated, 0 deleted, 0 skipped, 0 conflicting, 0 invalid. Readback matches the plan exactly; the 4 runtime-smoke messages are intact.

| | messages | memory_records | moment_records | total |
|---|---:|---:|---:|---:|
| planned | 341 | 4 | 155 | **500** |
| inserted | 341 | 4 | 155 | **500** |
| skipped | 0 | 0 | 0 | 0 |
| conflicting | 0 | 0 | 0 | 0 |
| invalid | 0 | 0 | 0 | 0 |
| updated (UPDATE) | 0 | 0 | 0 | **0** |
| deleted (DELETE) | 0 | 0 | 0 | **0** |

## Pre-execution re-validation

| Check | Result |
|---|---|
| Source artifact hashes | `InternalBeyond_auto_2026-09-02.json` = `1170f2a8…` ✓ · `InternalBeyond_auto_2026-08-27.json` = `5963c2d3…` ✓ |
| Import plan hash / identity | `tmp/legacy-data-import-plan.json` sha256 `3cc50b1c8431b64b152ddec89fefdf1f9afb5fe16906dbff841d47a06fe665e3`, status `READY_FOR_LEGACY_DATA_IMPORT` |
| Target still lacks the 500 stable IDs | collisions = **0** |
| CONFLICTING | **0** |
| INVALID | **0** |

## Import

- messages: `putMessages(341, {existingPolicy:'skip'})` → `{created:341, updated:0, skipped:0}` (single transaction)
- memory_records: `putRecords(4, {existingPolicy:'skip'})` → `{created:4, updated:0, skipped:0}` (single transaction)
- moment_records: `writeMigrated(record)` × 155 → `{created:155, skipped:0, other:0, errors:[]}` (per-record transaction; existing rows would have been skipped, never overwritten)

INSERT-only; no UPDATE; no DELETE; no soft-delete tombstones were produced. On any batch error the store's `BEGIN IMMEDIATE` transaction rolls back that batch — no DELETE-based rollback was used and none was needed.

## Readback

| Check | Result |
|---|---|
| historical messages present | **341 / 341** |
| historical memory_records present | **4 / 4** |
| historical moment_records present | **155 / 155** |
| runtime-smoke messages still present | **4 / 4** |
| soft-deleted rows (`deleted_at` non-null) | **0 / 0 / 0** |

## Final counts

```
messages        = 345   (4 runtime-smoke + 341 imported)
memory_records  = 4
moment_records  = 155
```

## Scope

Not touched: `characters` / character projection (WriteSet B), `character_runtime_specs` / `spec_json`, Active rearm, credentials, Vault, apiConfigs, provider configuration. No R3-C/C3.5 machinery, no old frozen target snapshot, no composite approval, no sidecar remediation, no new recovery/approval/checkpoint framework. No record bodies or secrets emitted.

A pre-import copy of `home-node.db` (+ wal/shm) is at `.yanagent/evidence/home-node-import-pre/` for rollback reference.

## Final status

`LEGACY_DATA_IMPORT_COMPLETE` — stopping here; not entering character projection.
