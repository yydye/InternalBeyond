# RECOVERY FINALIZE R1 REPORT

Generated: 2026-09-26  
Status: `READY_FOR_RECOVERY_FINALIZE_APPLY`

## Result

Implemented the minimal **Recovery Finalize Authority** in the native host: a new boot-policy branch, a new plan-pinned `recovery-finalized.json` marker, and a new `finalize_recovery` command. It lets a **verified** recovery with a **credential-ready** digest and **no open apply window** reach `RecoveryBootMode::Normal` while **retaining** the checkpoint artifact. No service is spawned, `ACTIVE_REARM_ENABLED` is untouched, and no data is restored.

This phase implemented and tested the authority only. It was **not applied** to production: no `recovery-finalized.json` exists, no first-boot marker was consumed, and no host was launched.

## Implementation (only `src-tauri/src/lib.rs`)

| Added | Detail |
|---|---|
| Consts | `RECOVERY_FINALIZED_SCHEMA = "internalbeyond.recovery-finalized"`, `RECOVERY_FINALIZE_PHRASE = "RECOVERY_FINALIZE"` |
| `RecoveryFinalizeRequest` | `{ planId, credentialReadyDigest, confirmation }` (`deny_unknown_fields`) |
| `RecoveryFinalizedMarker` | `{ schema, version, planId, lifecycleId, checkpointFileSha256, verifiedAt, credentialReadyDigest, authorizedAt }` |
| `finalized_marker_path` | `%LOCALAPPDATA%\InternalBeyond\recovery-finalized.json` |
| `recovery_boot_mode_name` | mode → name (`Normal`/`FirstBootPending`/`ActiveQuarantine`/`Blocked`) |
| `read_finalized_marker_valid_for` | validity = schema + version + planId + lifecycleId + checkpoint file hash + non-empty times + sha256 credential digest |
| `finalized_marker_well_formed` | orphan-cleanup validity check |
| Policy branch A | checkpoint-absent + orphan markers: well-formed finalize → `Normal`, else `Blocked` |
| Policy branch B | after verified-marker validation, a plan-pinned finalize marker → `Normal` (checkpoint retained) |
| `finalize_recovery` command | registered in the normal handler (with `acknowledge_recovery_first_boot`) |

### Preconditions enforced by `finalize_recovery`

1. **checkpoint integrity** — `validate_recovery_checkpoint` + `validate_checkpoint_lifecycle_files(..., true)`
2. **verified marker** — present, schema/version valid, `planId` aligned, `verifiedAt` non-empty
3. **credential-ready digest** — 64-hex `credentialReadyDigest` required (secret-free)
4. **no open apply window** — `recovery_apply_window_matches(planId, None, None) == false`
5. **plan binding** — `checkpoint.planId == request.planId`; confirmation phrase required

### Behavior

- Success → writes `recovery-finalized.json`; the command recomputes `recovery_boot_policy_from_dir` and returns `bootMode` (verified `Normal` in tests).
- **Checkpoint retained** — `recovery-checkpoint.json`, `-intent`, `-ready`, `-verified` are all preserved (no deletion; recovery evidence intact).
- Next start resolves `Normal` → Bridge / Home Node / ordinary runtime may start through the normal path.
- Replay: if a valid, plan-pinned marker already exists → `{ok:true, alreadyFinalized:true}`; a foreign/unpinned marker → `RECOVERY_FINALIZE_MARKER_FOREIGN`.

## Tests

| Check | Result |
|---|---|
| `cargo check --offline` | **PASS** (Finished dev profile) |
| `cargo test --offline recovery_finalize_boot_policy_matrix` | **PASS** (1/1) |
| Full `cargo test --offline` | **71 passed; 1 failed** |

Required coverage (all in `runtime_authority_tests::recovery_finalize_boot_policy_matrix`):

| Case | Assertion |
|---|---|
| **FirstBootPending** | checkpoint + verified, no consumed → `FirstBootPending` |
| **ActiveQuarantine** | + consumed marker → `ActiveQuarantine` |
| **Finalize success** | + valid plan-pinned finalize marker → `Normal`; `checkpoint.json` still exists |
| **Finalize replay** | marker re-validated (`read_finalized_marker_valid_for`) and policy still `Normal` |
| **Finalize invalid** | foreign-plan marker → policy stays `FirstBootPending` (not `Normal`) |

The single full-suite failure is **pre-existing and unrelated**: `c35_runner_report_tests::host_invocation_snapshot_contains_hashes_presence_and_bounded_context_only` (an env-value leak assertion). Proven pre-existing by stashing my `lib.rs` and running it at HEAD `85f91be`, where it fails identically (panicked at the pre-edit line 5597). No test regressed from this change.

## Constraint compliance

| Forbidden | How avoided |
|---|---|
| restore messages / memory / moments / characters | no data path touched; finalize is lifecycle-only |
| Active rearm | not invoked; `ACTIVE_REARM_ENABLED` unchanged (never referenced) |
| modify `ACTIVE_REARM_ENABLED` | untouched (`false`) |
| delete checkpoint (bypass) | checkpoint + lifecycle + verified artifacts **retained**; only a new audit marker is added |
| directly start a service | `finalize_recovery` spawns nothing; it only writes a marker the policy reads |
| skip the recovery policy | the transition is a new branch **inside** `recovery_boot_policy_from_dir` |

## Scope notes

- Only `src-tauri/src/lib.rs` changed (328 insertions / 4 deletions). No installer build, no data apply, no restore, no launch.
- A JS page wrapper (`assets/js/recovery-finalize.js`) and wiring into `InternalBeyond.html` were **deferred**: the command is invokable through the existing Tauri bridge, and adding a script to `InternalBeyond.html` risks the exact-count frontend structure test. This is a follow-up, not a blocker.
- Production state unchanged: `recovery-finalized.json` absent, `recovery-first-boot-consumed.json` absent, 0 stray processes, HEAD still the checkpoint commit plus this one working-tree change.

## Final status

`READY_FOR_RECOVERY_FINALIZE_APPLY` — the Recovery Finalize Authority is implemented, compiles, and its full transition matrix (FirstBootPending / ActiveQuarantine / success / invalid / replay) is covered by a passing native test. The next authorized phase is to apply it (build/install the host that contains the command and invoke `finalize_recovery`), which this phase did not do.
