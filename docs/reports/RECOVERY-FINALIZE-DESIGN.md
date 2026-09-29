# RECOVERY FINALIZE DESIGN

Generated: 2026-09-26  
Status: `READY_FOR_RECOVERY_FINALIZE`  
Scope: state-machine analysis + minimal design only. No installer build, no data apply, no messages/memory/moments restore, no R3.

## 1. Recovery lifecycle state machine

### 1.1 Artifacts (`%LOCALAPPDATA%\InternalBeyond\`)

| Artifact | Written by | Meaning |
|---|---|---|
| `recovery-checkpoint.json` | `write_recovery_checkpoint` (RecoveryOnly) | R3-B.3 pre-apply snapshot; native validation requires `phase == "PREPARED"`, `firstBootPending == true`, `activeQuarantined == true` |
| `recovery-checkpoint-intent.json` | `persist_checkpoint_lifecycle_artifacts_with` | lifecycle `phase RESERVED`, plan-bound, `owner` record |
| `recovery-checkpoint-ready.json` | same | lifecycle `phase READY`, same artifact |
| `recovery-checkpoint-verified.json` | `mark_recovery_checkpoint_verified` | restore verified marker (plan-bound) |
| `recovery-first-boot-consumed.json` | `acknowledge_recovery_first_boot` | first boot acknowledged (plan-bound) |
| *(new in this design)* `recovery-finalized.json` | **Recovery Finalize Authority** | recovery lifecycle retired → next start is `Normal` |

### 1.2 Boot modes (`RecoveryBootMode`, `src-tauri/src/lib.rs:474`)

`Normal`, `FirstBootPending`, `ActiveQuarantine`, `Blocked`.  
`suppress_services() = mode != Normal`; `active_quarantined() = mode != Normal`; `blocked() = mode == Blocked`.

### 1.3 RECOVERY_STATE_TRANSITION_MATRIX

Derivation: `recovery_boot_policy_from_dir` (`lib.rs:1930`) + `assets/js/recovery-first-boot.js::resolvePolicy`. Let **C** = checkpoint present & valid, **V** = verified marker valid & plan-aligned, **K** = consumed marker valid & plan-aligned, **I/R** = intent/ready lifecycle files valid, **F** = finalized marker valid & plan-aligned (proposed).

| # | C | I/R | V | K | F | Services | Mode | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | – | – | – | – | – | **on** | **Normal** | no recovery state |
| 2 | – | any | – | – | – | off | **Blocked** | orphaned lifecycle marker (`RECOVERY_CHECKPOINT_LIFECYCLE_INCOMPLETE`) |
| 3 | ✔ | ok | – | – | – | off | **Blocked** | unverified (`restore-not-verified`) |
| 4 | ✔ | ok | ✔ | – | – | off | **FirstBootPending** | current real state |
| 5 | ✔ | ok | ✔ | ✔ | – | off | **ActiveQuarantine** | after `acknowledge_recovery_first_boot` — **still suppresses services** |
| 6 | ✔ | bad | any | any | – | off | **Blocked** | lifecycle/verified/consumed mismatch |
| 7 | – | any | any | any | ✔ | — | **Blocked** *(proposed: Normal)* | post-cleanup finalize |
| 8 | ✔ | ok | ✔ | any | ✔ | **on** | **Normal** | **new finalize transition** |

Existing implemented edges: `4 → 5` (consume marker), `4 → Blocked`, `1 ↔ {2..6}`.  
**Missing edge: `5 → 1/Normal`.** Today the only exits from a checkpoint are `abort_recovery_checkpoint_before_apply` (pre-apply cancel) and `clear_recovery_checkpoint_after_rollback` (rollback, requires `rollback_verified = true` and the production-restore/apply-window gate). There is **no success-path transition to `Normal`**.

## 2. ActiveQuarantine — design purpose

`ActiveQuarantine` is the post-acknowledgment holding state: the recovery is verified and the first boot is acknowledged, but the runtime stays fail-closed (`suppressServices: true`, `suppressActive: true`). Purpose (per `R3-C-AUTHORITY-MATRIX.json` and `recovery-first-boot.js`):

- Prevent the autonomous **Active** scheduler from replaying stale events / generating messages against not-yet-cleared restored data — "*Keep Active quarantined; safe scheduler policy must be explicitly approved before a later start.*"
- Keep the Node runtime services (static/bridge/active/homeNode/restart) **down** until the recovery lifecycle is deliberately retired.
- Gate Active re-arm on `activeRearmReadiness` (recovery COMPLETE, database verification PASS, R3-C migration COMPLETE, credential provider state resolved, stale events cleared) — and `ACTIVE_REARM_ENABLED = false` in this build.

So quarantine is intentional, not a bug; the missing piece is an explicit authority to leave it for `Normal`.

## 3. Which state controls `mode == Normal`

From `recovery_boot_policy_from_dir`:

- `Normal` iff **`recovery-checkpoint.json` is absent** AND **none** of `recovery-checkpoint-intent.json`, `-ready.json`, `-verified.json`, `recovery-first-boot-consumed.json` exist.
- A checkpoint alone → `FirstBootPending` (then `ActiveQuarantine` after consume). Nothing removes the checkpoint on the success path.

Therefore today the only way to `Normal` is either (a) delete all five artifacts (a bypass, forbidden) or (b) the rollback clear. The design below adds a legitimate, gated transition **without deleting the checkpoint**.

## 4. Existing quarantine → Normal path?

| Path | Exists? | Semantics | Fit |
|---|---|---|---|
| `abort_recovery_checkpoint_before_apply` | yes | cancels a checkpoint *before apply*; consumes approval token; removes I/R/artifact | not a success path |
| `clear_recovery_checkpoint_after_rollback` | yes | requires `rollback_verified = true` + `PRODUCTION_RESTORE_ENABLED || apply-window`; removes checkpoint + verified + consumed | rollback only; **not** a verified-recovery finalize |
| **success finalize** | **no** | — | **the gap this design fills** |

## 5. Minimal design: Recovery Finalize Authority

### 5.1 Principle

Add one explicit, precondition-gated, audited authority that lets a **verified** recovery with **credential ready** and **no pending apply** reach `Normal`, by **adding a policy branch** — never by deleting the checkpoint, forcing `mode`, starting services, changing `ACTIVE_REARM_ENABLED`, or skipping the policy.

### 5.2 New artifact — `recovery-finalized.json`

```
{
  "schema": "internalbeyond.recovery-finalized",
  "version": 1,
  "planId": "<checkpoint.planId>",
  "lifecycleId": "<32 hex>",
  "checkpointFileSha256": "<sha256(recovery-checkpoint.json)>",
  "verifiedAt": "<from verified marker>",
  "credentialReadyDigest": "<sha256(JSON.stringify(sorted ready bindingIds))>",
  "authorityRevisionId": "<e.g. r3e-finalize:<rev>>",
  "finalizedAt": "unix-ms:<ms>"
}
```

Written with the existing `write_new_json` (create-new, atomic, ≤1 MiB). The checkpoint and its lifecycle files are **retained** as the rollback snapshot + audit trail.

### 5.3 Policy change (one new branch)

In `recovery_boot_policy_from_dir`, after the verified check (`lib.rs:2001`) and before the `!consumed_path.exists()` check, insert:

```
if finalize_marker_valid(consumed-or-not) && plan-aligned && verified valid {
    return RecoveryBootPolicy { mode: Normal, plan_id: Some(checkpoint.plan_id) };
}
```

Add `RecoveryBootMode` usage unchanged (no new variant needed); `Normal` already means "services on". This is a **new legitimate transition inside the policy**, not a skip.

### 5.4 Native command — `finalize_recovery`

Registered in the **normal** handler next to `acknowledge_recovery_first_boot` (`lib.rs:5255`); **not** gated by `PRODUCTION_RESTORE_ENABLED` (it performs no data apply). Body:

1. `recovery_data_root()` + read `recovery-checkpoint.json`; `validate_recovery_checkpoint` (phase PREPARED).
2. `validate_checkpoint_lifecycle_files(root, &checkpoint, &bytes, true)`.
3. Verified marker present, valid, `planId` aligned.
4. `recovery_apply_window_matches(&plan_id, None, None) == false` → **no pending apply**.
5. Target identity/origin match the host `RecoveryOnlyHostState`.
6. **Credential Ready** (secret-free): call the existing bounded, has-only resolver status path for the frozen binding set and require all ready; derive `credentialReadyDigest`. No secret is read (adapter `vault.has` only).
7. Explicit authority: require a one-use confirmation phrase `RECOVERY_FINALIZE` plus a native confirmation, mirroring `confirm_native_restore_approval` (new approval kind `RECOVERY_FINALIZE_APPROVAL`; one-use, plan-bound).
8. Write `recovery-finalized.json` via `write_new_json` (idempotent: if already present and plan-aligned → `{alreadyFinalized:true}`).
9. Return `{ok:true, finalized:true, planId, nextBoot:"Normal"}`.

It does **not** spawn services, touch `ACTIVE_REARM_ENABLED`, or delete the checkpoint.

### 5.5 JS authority (RecoveryOnly/normal page)

`assets/js/recovery-finalize.js` (UMD, host-marker gated like `recovery-shell.js`):

- `preflightFinalize()` → reads checkpoint/verified via `read_recovery_checkpoint`, runs the secret-free credential readiness through the same adapter used by the rebind verification, asserts `noPendingApply = !applyWindowOpen`.
- `finalizeRecovery({confirmation})` → requires the phrase; invokes `finalize_recovery`; returns the report.
- Never opens IndexedDB, never reads a secret, never starts a service.

### 5.6 Minimal test surface (design targets)

- `recovery_boot_policy_from_dir` unit tests: edges #7/#8 in the matrix; `F` foreign plan → `Blocked`; `F` without `V` → `Blocked`; `F` valid → `Normal`.
- `finalize_recovery` contract: refuses on unverified / open apply window / target mismatch / credential-not-ready / wrong phrase; writes the marker once; no service spawn; `ACTIVE_REARM_ENABLED` unchanged; checkpoint hash unchanged after finalize.
- JS: `preflightFinalize` fails closed when any precondition is missing.

## 6. Constraint compliance

| Forbidden by this task | How the design avoids it |
|---|---|
| delete checkpoint to bypass | Finalize **retains** the checkpoint; it adds a policy branch + an audit marker, never ad-hoc deletion |
| force `mode` | `mode` is computed by `recovery_boot_policy_from_dir`; the authority only creates the marker the policy reads |
| start services directly | Finalize spawns nothing; services start normally only because the policy next resolves `Normal` |
| modify `ACTIVE_REARM_ENABLED` | untouched (`false`); finalize does not re-arm Active |
| skip recovery policy | the new transition lives **inside** the policy as an explicit, marker-driven edge |

## 7. Residuals / risks

- **Data restore still pending.** `recovery-checkpoint.json` phase is `PREPARED` and the R3-B.3 data apply was never executed. Finalizing retires the lifecycle gate so ordinary IB can run, but it does **not** restore messages/memory/moments. That remains a separate, explicitly-authorized phase; this design does not do it.
- **Retained snapshot.** Because the checkpoint is retained, `recovery-checkpoint.json` + lifecycle files persist after finalize; #7 in the matrix (checkpoint absent but markers present) must be handled fail-closed (`Blocked`) unless a valid `F` exists.
- **One-way door.** Finalize is a one-use authority; a later rollback would need its own re-issue. Idempotency and plan-binding must be enforced as in the existing approval flow.

## Final status

`READY_FOR_RECOVERY_FINALIZE` — the transition gap is precisely located (no `ActiveQuarantine → Normal` success edge), the controlling state (`checkpoint + 4 markers`) is identified, and a minimal, constraint-compliant Recovery Finalize Authority is designed. Implementation was intentionally not performed in this phase.
