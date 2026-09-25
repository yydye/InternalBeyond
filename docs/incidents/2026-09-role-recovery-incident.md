# 2026-09 Role Recovery Incident

## Incident Summary

This is a role-data recovery-chain investigation, not a report of a business-service failure. The R3-B.3 production restore completed and was formally verified: 539/539 planned records restored, zero dangling references, provenance 539/539, OLD → NEW identity succession passed, zero secrets restored, zero provider calls, and Active remained quarantined.

The subsequent R3-C.3.5 work evaluated whether the frozen Home Node reconstruction proposal could safely proceed. Its canonical RecoveryOnly pipeline now reaches the runner, emits a versioned failure report, and displays the typed blocker. No R3-C reconstruction was applied. The current gate remains `P32-W5-R3-C3.5 = BLOCKED_C35_HOME_NODE_SIDECAR_INVALID`; `R3-C = NOT_READY`.

## Timeline

- **2026-09-03 (backup filename date):** Supplemental source is named `IB_backup_2026-09-03.json`. The filename date is not the discovery date.
- **2026-09-24 (R3-C.2):** The supplemental source was reconciled to the frozen source binding by SHA-256 `37f45afe4c4477931dd475ec8be3816e75133bc361a6b471b088be7d70ed198d`. NEW role projection evidence was marked resolved. The OLD → NEW succession remained the user-confirmed mapping; neither source authority nor succession was reopened.
- **2026-09-24 10:09 UTC:** R3-C.2 field-authority report recorded zero character identity conflicts and zero unresolved canonical business-data conflicts. The 500-row INSERT proposal was independent of character projection differences. Model authority was assigned to Web Core; Home Node `characters.model` was classified as a legacy duplicate; capabilities as a derived runtime projection. Runtime spec parity was deferred.
- **Before and during C3.5:** RecoveryOnly preview, dry-run reporting, and reconstruction adapter boundaries were prepared. The C3.5 proposal remained frozen as WriteSet A (500 INSERT, 0 UPDATE, 0 DELETE) plus WriteSet B (8 UPDATEs limited to `characters.dto_json.model` and `characters.dto_json.capabilities`). No production reconstruction writes occurred.
- **2026-09-25 (C3.5-A/B):** An orphaned RecoveryOnly Host lifecycle defect was audited and a RecoveryOnly-only final-window exit path was added. Canonical RecoveryOnly closure later exited naturally; normal Host lifecycle was left unchanged.
- **2026-09-25 05:10–09:43 UTC (C3.5-E through I):** Sidecar evidence was frozen and canonical invocation failures were progressively narrowed. A historical canonical attempt had exit 1, empty stdout, and 655 stderr bytes; the raw stderr was not retained, so that individual event cannot be directly attributed.
- **2026-09-25 11:42 UTC (C3.5-J):** Instrumentation established the native child process was created, while the runner had not reached JavaScript entry in the failing invocation.
- **2026-09-25 12:07 UTC (C3.5-K):** Changing CWD representation alone did not resolve the failure. `NODE_OPTIONS` removal did not change the failure fingerprint. USERPROFILE was not guessed or reconstructed because the raw reference was unavailable.
- **2026-09-25 12:47 UTC (C3.5-K2):** Synthetic shared-helper A/B/A testing confirmed `EXTENDED_LENGTH_SCRIPT_ARGUMENT`: the extended-length script argv failed before the JS marker, the equivalent plain Win32 absolute path passed, and restoring the extended path reproduced the failure. Test-harness parent context differed from the canonical Tauri Host, so canonical acceptance remained required.
- **2026-09-25 13:12 UTC (C3.5-K3):** The script argv normalization fix passed regression tests and fresh canonical payload acceptance. The canonical Host → Node child → runner bootstrap → adapter → native parser → RecoveryOnly UI path completed. The runner returned the typed `C35_HOME_NODE_SIDECAR_INVALID` blocker; no retry was performed.
- **2026-09-25 13:41 UTC (C3.5-L):** Read-only sidecar disposition classified the 32 KiB SHM as `INVALID_ORPHAN_ARTIFACT`. Its historical producer provenance remains unattributed. The main database and sidecar content hashes matched the K3 pre/post evidence.

## Root Causes

### A. Confirmed — `EXTENDED_LENGTH_SCRIPT_ARGUMENT`

In the shared native spawn helper, Node process creation succeeded, but a script argv expressed as an extended-length Windows path did not reach JavaScript entry. The equivalent plain Win32 absolute path to the same bytes passed. K2 confirmed the result with a FAIL → PASS → FAIL sequence. K3 normalizes only the child script argument after canonical in-root, same-target, and same-file-hash validation. The K3 canonical RecoveryOnly acceptance passed.

The older 655-byte stderr fingerprint is consistent with this cause, but the raw historical stderr is unavailable. This does not directly prove the cause of every earlier invocation.

### B. Confirmed — `INVALID_ORPHAN_ARTIFACT`

The current `home-node.db-shm` has an invalid WAL-index page-size field (`szPageRaw=0`) in both header copies. `home-node.db-wal` is zero bytes, and read-only holder checks found no process holding the DB or either sidecar. The canonical dry-run therefore stops at `adapter_open` and returns a valid versioned failure report with `ok=false`, `writeAllowed=false`, and `applyAllowed=false`.

This finding describes the current sidecar structure and ownership state. It does not establish main database corruption or identify the historical process that created the SHM.

### C. Not confirmed — historical SHM producer provenance

Available timestamps, process/handle checks, and prior lifecycle reports do not identify the SHM producer. No attribution is made.

## Permanent Fixes

- **Child script argv normalization:** Normalize only an already validated canonical child script path to an equivalent plain Win32 absolute path. The canonical source and normalized target must resolve to the same file and SHA-256; unsupported extended UNC and relative paths fail closed.
- **RecoveryOnly lifecycle closure:** Closing the last RecoveryOnly window now completes RecoveryOnly resource cleanup and requests Tauri exit once no scoped dry-run remains active. Ordinary Host lifecycle behavior is unchanged.
- **Typed dry-run failure boundary:** Invalid sidecars produce a versioned, zero-mutation failure report that the native parser accepts and the RecoveryOnly UI presents as a safe blocker. Diagnostics do not create approval, checkpoint, apply window, or reconstruction activity.
- **Authority/projection separation:** R3-C.2 froze Web Core as the `model` authority, classified Home Node `characters.model` as a legacy duplicate, and classified capabilities as a derived runtime projection. The insert-only 500-row proposal remains separate from the 8-row character projection UPDATE write set. Runtime specs remain deferred to R3-D; this incident did not inspect `spec_json` or change runtime bindings.

## Current State

- R3-B.3 production restore: **PASS**, 539/539, per the final restore report.
- Main database: preserved across K3 dry-run pre/post evidence; SHA-256 `eaad098dccfc21835a0b079da03d28f4323fc977abfe94a289d8aeb471c18276`. Logical business-table integrity was not assessed during the sidecar audit.
- `home-node.db-wal`: present, 0 bytes; SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- `home-node.db-shm`: present, 32,768 bytes; SHA-256 `fd4c9fda9cd3f9ae7c962b0ddf37232294d55580e1aa165aa06129b8549389eb`; state `INVALID_ORPHAN_ARTIFACT`.
- Windows Last Access updates advanced the DB/SHM access-time metadata during read-only hashing/header inspection; no explicit timestamp mutation was issued. File size, creation time, last-write time, and content hashes remained unchanged.
- `cleanupAuthorized=false`; `reconstructionAuthorized=false`; `applyAuthorized=false`.
- Active remains quarantined; normal runtime is stopped. C3.5 reconstruction, approval, checkpoint, apply, restore, provider calls, credential/Vault access, and `spec_json` access were not performed.
- Final gate: `P32-W5-R3-C3.5 = BLOCKED_C35_HOME_NODE_SIDECAR_INVALID`; `R3-C = NOT_READY`.

## Evidence

- [C3.5 K2 pre-JS isolation report](../../tmp/p32-w5-r3b/P32-W5-R3-C3.5-K2-PRE-JS-ENV-ISOLATION.json)
- [C3.5 K3 canonical acceptance report](../../tmp/p32-w5-r3b/P32-W5-R3-C3.5-K3-SCRIPT-ARGV-NORMALIZATION-ACCEPTANCE.json)
- [C3.5 L sidecar disposition report](../../tmp/p32-w5-r3b/P32-W5-R3-C3.5-L-HOME-NODE-SIDECAR-DISPOSITION.json)
- [R3-C.2 field authority report](../../tmp/p32-w5-r3b/P32-W5-R3-C2-CHARACTER-PROJECTION-AUTHORITY-REPORT.json)
- [R3-B.3 production restore final report](../../tmp/p32-w5-r3b/P32-W.5-R3-B.3-production-restore-final-report.json)
- [C3.5 closure report](../../tmp/p32-w5-r3b/P32-W5-R3-C3.5-CLOSURE-REPORT.json)
