# RECOVERY FINALIZE R1 APPLY REPORT

Generated: 2026-09-26  
Status: `RECOVERY_RUNTIME_UNLOCKED`

## Result

The Recovery Finalize Authority was **applied**. A host built from the current source (containing `finalize_recovery`) was deployed into the canonical install root; launched under `FirstBootPending`; preflighted; `finalize_recovery` returned `{ok:true, finalized:true, bootMode:"Normal"}`; `recovery-finalized.json` was written with a correct plan binding; and an independent boot-policy probe confirmed `RecoveryBootMode = Normal`. All recovery evidence was retained; no data was restored; no service was started by the finalize itself.

## Steps

| # | Step | Evidence |
|---|---|---|
| 1 | Build host with `finalize_recovery` | `cargo build --release --features custom-protocol --locked` → `target/release/internalbeyond-host.exe`, **38,542,336 bytes**, PE `ProductVersion 1.0.6`, sha256 `bcc9b5005e8a68744a88c1a9df3cc1e6cc6d0d376962e558b97925790f79fdf2` |
| 2 | Deploy (install) into canonical root | Original host backed up (sha256 `baa21b65116fbc987c43ca372ecad5adb66c5832c43dffdf3ff9e89581b3e42e`, 31,388,672 bytes); new host copied to `%LOCALAPPDATA%\Programs\InternalBeyond\internalbeyond-host.exe`. **Payload manifest untouched** (`af343f254c1270046cc9ea9e0ef00cc24699d01c7be8fbfe9274a4fcfeee4b32`) to preserve the recovery target identity |
| 3 | Launch (recovers under `FirstBootPending`) + preflight | Host target `http://tauri.localhost/InternalBeyond.html?ib_tauri_host=1`; flags `__IB_RECOVERY_FIRST_BOOT__=true`, `__IB_RECOVERY_ACTIVE_HOLD__=true`, `__IB_RECOVERY_BOOT_BLOCKED__=false`; checkpoint `planId r3b3:1ee6aba8…`, `lifecycleId 4ce78bf19f8c402bb6767f20b057d242`, file sha256 `96fdc0aa…`; verified marker aligned; credential **13/13 ready**; no open apply window; plan binding matched |
| 4 | Invoke `finalize_recovery` | `window.__TAURI__.core.invoke('finalize_recovery', {request:{planId, credentialReadyDigest, confirmation:'RECOVERY_FINALIZE'}})` → **`{ok:true, finalized:true, planId:"r3b3:1ee6aba8…", bootMode:"Normal"}`** |
| 5 | Verify `recovery-finalized.json` | Present (445 bytes, 2026-09-26 09:06:44); `schema internalbeyond.recovery-finalized`, `version 1`, `planId`/`lifecycleId`/`checkpointFileSha256` all match the checkpoint (`markerBindingOk=true`); `credentialReadyDigest = 75ed7e4984df9b67f65f92408d359135465dae64d634c20770d3103d039c2de8` (the frozen 13-id set hash) |
| 6 | Boot-policy probe (relaunch) | Flags `__IB_RECOVERY_FIRST_BOOT__=false`, `__IB_RECOVERY_ACTIVE_HOLD__=false`, `__IB_RECOVERY_BOOT_BLOCKED__=false` → **`RecoveryBootMode::Normal`** |

## Evidence retained (no deletion)

```
recovery-checkpoint.json         75,387 B  (sha256 96fdc0aa… unchanged)
recovery-checkpoint-intent.json   2,168 B  (unchanged)
recovery-checkpoint-ready.json    2,165 B  (unchanged)
recovery-checkpoint-verified.json   186 B  (unchanged)
recovery-finalized.json             445 B  (NEW — the finalize marker)
```

`recovery-first-boot-consumed.json` remains **absent** (finalize supersedes first-boot consumption; the marker is the authority the policy reads).

## Finalize preconditions (all satisfied)

1. checkpoint integrity + lifecycle files — `validate_recovery_checkpoint` + `validate_checkpoint_lifecycle_files(..., true)`
2. verified marker — present, plan-aligned
3. credential-ready digest — well-formed 64-hex, derived from 13/13 ready Vault bindings (secret-free)
4. no open apply window — `recovery_apply_window_matches == false`
5. plan binding — `checkpoint.planId == request.planId` + `RECOVERY_FINALIZE` confirmation

## Constraint compliance

| Forbidden | Status |
|---|---|
| restore data / messages / memory / moments / characters | **not done** |
| R3-C / R3-D | **not done** |
| Active rearm / `ACTIVE_REARM_ENABLED` change | **not done** (untouched, still `false`) |
| delete checkpoint (bypass) | **not done** — all recovery artifacts retained |
| directly start a service | **not done** — `finalize_recovery` spawns nothing; services start only via the normal boot path now that the policy is `Normal` |

Post-run sweep: 0 `internalbeyond-host.exe` processes and 0 listeners on the protected ports (23114/23115/23116/23118/23120/8765).

## Deviation notes

- The deployed host was built with the canonical recipe flags (`--release --features custom-protocol --locked`) but **without** `-C strip=debuginfo`, so it is larger than the canonical artifact. Behavior is identical; a later canonical installer build can restore the stripped artifact.
- A **full canonical installer was intentionally not built/run**: staging regenerates `ib-payload-manifest.json`, which would change the payload identity embedded in the recovery `target_identity` and break the checkpoint plan binding. Deploying the host only preserved the binding (verified: payload manifest hash unchanged).
- Original host binary backed up at `.yanagent/evidence/internalbeyond-host.1.0.6.original.exe` for rollback.

## Residual

The R3-B.3 **data restore was never applied** — `recovery-checkpoint.json` phase is `PREPARED`. Finalize unlocked the runtime; it did not restore messages/memory/moments/characters. That remains a separate, explicitly-authorized phase. Stopping here — not entering data restore.

## Final status

`RECOVERY_RUNTIME_UNLOCKED` — `RecoveryBootMode = Normal`; Bridge / Home Node / ordinary runtime may start through the normal boot path on the next launch.
