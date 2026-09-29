# R3-C DATA RESTORE REPORT

Generated: 2026-09-26  
Status: `BLOCKED_R3C_DATA_RESTORE`

## Result

The frozen WriteSet A restore was **not executed**. Every sanctioned path to a Home Node production write is deliberately closed (dry-run only; production adapter refuses mutations; no composite approval; target identity drifted; lifecycle `NOT_READY` with a sidecar blocker). No record was inserted, no `characters` projection was updated, no credential/Vault was touched, and no provider call was made. The Home Node database is unchanged by this turn.

## Frozen WriteSet A identity (verified from the packaged frozen artifacts)

| Item | Value |
|---|---|
| Bundle | `p32w5-r3c3:73527c524f091a8a44374090` · `bundleSha256 73527c524f091a8a4437409069979c2141f03b7048f8a042ae912c645e33bf7d` |
| WriteSet A | `writeSetSha256 c12255e8483c090ba53d15f711da63b6579a78721010e7a1aedc73b50dd916cf` · `INSERT` · rows `500` |
| Domain INSERT counts | `messages 341`, `memory_records 4`, `moment_records 155` (currents: user-stated 341 / 4 / 155 ✓) |
| Frozen proposal artifact | `c2f567943f299621537077a73739bb16853b99f474fe74407e20e3033febb70a`; insert-subset `52819e4686ab0bea58985b108b0362e57a4efb145bd30a44f9dcddb4c2e96061` |
| Source | `sourcePrimarySha256 1170f2a8…` (`D:\新建文件夹 (3)\InternalBeyond_auto_2026-09-02.json`, 45,062,434 B) |
| Plan | `r3b3:1ee6aba8…` · target snapshot `e353295cdb6d2c8bdd344b2b54bf4f5da59bbf7b2b85081380faefe022c76d9c` |
| Frozen artifacts on disk | `services/home-node/reconstruction-contracts/p32-w5-r3c3/{composite-bundle.json,home-node-reconstruction-write-set.json,home-node-proposed-write-set.json,…}` |

Pre-apply checks: bundle and WriteSet **hashes resolve to the frozen values**, but the **target identity does not match** (below).

## Blockers (all hard; no bypass taken)

1. **No production apply path exists.** `services/home-node/reconstruction-runner.js` is "RecoveryOnly-only … accepts exactly one native Tauri **dry-run** invocation … and **never exposes an apply mode**"; its report hard-codes `applyAllowed: false`. `services/home-node/production-reconstruction-adapter.js` refuses **every** Home Node mutation: `putMessages()/putMemoryRecords()/writeMigratedMoment()/applyCharacterDtoProjectionBatch()` all call `_rejectMutation()` → `C35_PRODUCTION_APPLY_DISABLED`.
2. **No composite approval.** The frozen bundle `approvalPolicy.currentCompositeApprovalIssued = false` and `currentC3_3AuthorizationCoversBothSets = false`. The single composite approval binds A **and** B together; B is the character-projection UPDATE this task forbids, so the composite scope cannot be honored as A-only.
3. **Target identity drifted.** Frozen `targetHomeNodeIdentity.c1ObservedDatabaseSha256 = eaad098dccfc21835a0b079da03d28f4323fc977abfe94a289d8aeb471c18276` with `revalidationRequiredAtExecution: true`; the live `home-node.db` now hashes to `6cb4bb8215cc86e3…` (651,264 B) — it changed after the frozen plan (ordinary runtime writes). The frozen target is stale.
4. **Lifecycle `NOT_READY` + sidecar blocker.** `tmp/p32-w5-r3b/P32-W5-R3-C3.5-CLOSURE-REPORT.json`: `gates.r3c = "NOT_READY"`, `applyAuthorized = false`, `reconstructionAuthorized = false`, blocked by `C35_HOME_NODE_SIDECAR_INVALID` (invalid `home-node.db-shm`), with "*Any future sidecar remediation requires a separate explicit contract and authorization.*"
5. **No record bodies in the write set.** `home-node-proposed-write-set.json` items carry `{table, operation, stableKey, source, targetExistence, precondition, conflictClassification, reason}` only — `sourceRecordBodiesIncluded: false`, `executionStatus: PRODUCTION_ONLY_NOT_AUTHORIZED` proposals. Bodies would have to be materialized from the 45 MB source under the frozen executor.

## Target state (read-only)

Home Node `home-node.db` currently: `messages = 4` (this session's smoke tests), `memory_records = 0`, `moment_records = 0`, `characters` present. The 500-row restore target is therefore genuinely absent — but restoring it requires the blocked production path.

## Not performed

No Home Node write; no `characters.dto_json` update (WriteSet B); no Active rearm; no credential or Vault change; no provider migration; no R3-D; no `character_runtime_specs`/`spec_json` access; no rollback needed (nothing written).

## Unblock conditions (each owned by a separate, explicitly authorized phase)

1. Implement/bind an **official production write adapter** (the current one is mutation-disabled) and expose an apply mode (the runner is dry-run only).
2. Issue a **valid composite reconstruction approval** bound to this bundle/WriteSet/plan/target (or explicitly authorize an A-only scope, which the frozen composite policy does not currently cover).
3. **Re-freeze the target**: re-observe the live `home-node.db` hash, re-run target revalidation, and re-produce the plan snapshot binding.
4. **Resolve `C35_HOME_NODE_SIDECAR_INVALID`** under its own explicit contract/authorization.
5. Materialize the 500 record bodies from `sourcePrimarySha256 1170f2a8…` through the frozen executor with duplicate protection + readback.

## Final status

`BLOCKED_R3C_DATA_RESTORE` — frozen WriteSet A is identified and hash-verifiable, but no sanctioned production apply exists and the target/approval/lifecycle/sidecar gates are closed. Stopping here; not entering character projection.
