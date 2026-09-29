# RUNTIME SMOKE TEST REPORT

Generated: 2026-09-26  
Status: `BLOCKED_RUNTIME_SMOKE`

## Result

The runtime smoke was **not executed**. Starting ordinary IB right now is not a neutral smoke: a *verified* recovery checkpoint is present with **no** first-boot-consumed marker, so the host's next normal start resolves to `FIRST_BOOT_PENDING` and **suppresses all services**. That makes every required smoke check (page services, role-config read, apiConfig resolver, single chat request) unreachable, and making them reachable would require consuming the first-boot lifecycle marker — the "first boot migration" this task explicitly forbids and which the R3-C authority matrix assigns to **R3-E**.

Therefore this phase is blocked before step 1; no installer was built, nothing was installed, ordinary IB was not launched, and no provider request was made.

## Evidence

### Recorded recovery lifecycle state (fresh, on disk)

| File (`%LOCALAPPDATA%\InternalBeyond/`) | State |
|---|---|
| `recovery-checkpoint.json` | present — `schema: internalbeyond.recovery-checkpoint`, `version: 1`, `phase: PREPARED`, `planId: r3b3:1ee6aba8…44c7` |
| `recovery-checkpoint-verified.json` | present — `schema: …recovery-checkpoint-verified`, `version: 1`, matching `planId`, `verifiedAt: unix-ms:1790234711196` |
| `recovery-checkpoint-ready.json` | present — lifecycle `phase: READY`, `executionPhase: R3-B.3`, `targetOrigin: http://tauri.localhost`, domains include `apiConfigs, autoMemory, chatMessages, chatThreads, diary_entries, groups, memories, moments, roleLetters` |
| `recovery-first-boot-consumed.json` | **absent** |

### Host policy (source)

- `src-tauri/src/lib.rs::recovery_boot_policy_from_dir` reads `recovery-checkpoint.json` + `recovery-first-boot-consumed.json` (+ verified/lifecycle markers). With a valid checkpoint, a matching verified marker and **no consumed marker**, the policy is `FIRST_BOOT_PENDING` (`assets/js/recovery-first-boot.js::resolvePolicy` → `{mode:'FIRST_BOOT_PENDING', suppressServices:true, suppressActive:true, firstBootPending:true, activeQuarantined:true}`).
- `lib.rs:4980` `restricted_recovery_page || recovery_policy.suppress_services()` and `lib.rs:5221` `if !recovery_policy.suppress_services() { spawn_existing_launcher(&lifecycle); }` → under `FIRST_BOOT_PENDING` the launcher and its services (static 23120, bridge 23115, active 23114, homeNode 23118, restart 23116) are **not started**.
- The only consumption command, `acknowledge_recovery_first_boot` (`lib.rs:4088`), is registered **only** in the normal handler (`lib.rs:5255`) — consuming it is the forbidden first-boot migration.

### R3-C authority matrix

`tmp/p32-w5-r3b/R3-C-AUTHORITY-MATRIX.json`:

```
"runtimeProjectionStatus": "FIRST_BOOT_PENDING",
"r3cWriteAuthority": "0; consumed marker remains absent",
"laterPhaseOwner": "R3-E Controlled First Start owns first-boot consumption."
```

### Last known normal boot

`boot-state.json` — last normal launcher run `2026-09-23`, version `1.0.6`, root `[local path redacted]`, services healthy at that time. This **predates** the `2026-09-24` recovery checkpoint, so it does not clear the current gate.

## Why the smoke cannot pass under the stated limits

| Required smoke check | Reachable now? | Why |
|---|---|---|
| Page load (full app) | Blocked | First-boot policy restricts startup; services suppressed |
| Role config read | Blocked | Active/Home Node services not started |
| apiConfig resolver | Blocked | Bridge/Active not started |
| Single chat request | Blocked | Would also require a **provider call**, and services are suppressed |

The gate is **data-driven** (the checkpoint files in `%LOCALAPPDATA%`), not a property of the build. Building a new canonical installer would not change it, so step 1 was deferred rather than performed as unreachable work.

## Step status

| Step | Status |
|---|---|
| 1. Build canonical installer | **Not executed** (deferred; the downstream gate is a data gate, not fixed by a build) |
| 2. Install / launch ordinary IB | **Not executed** (would enter FIRST_BOOT_PENDING) |
| 3. Smoke checks (page / role config / resolver / chat) | **Not executed** |

| Metric | Value |
|---|---|
| Provider calls | **0** |
| IndexedDB writes | **0** |
| Vault mutations | **0** |
| Home Node / messages / memory / moments mutations | **0** |
| Ordinary IB launches | **0** |

No stray `InternalBeyond` process is running.

## Boundaries held

No installer build; no install; no ordinary IB launch; no first-boot consumption / migration; no Active re-arm; no R3 / reconstruction; no Home Node restore; no messages / memory / moments restore; no provider call; no writes to IndexedDB, Vault or Home Node.

## Unblock conditions

The runtime smoke can proceed only after the recorded first-boot lifecycle gate is resolved **by its owning phase** (R3-E Controlled First Start), which consumes the `FIRST_BOOT_PENDING` marker. Because this task excludes R3 and first-boot migration, one of the following must be authorized as a separate phase:

1. Authorize **R3-E Controlled First Start** to consume the first-boot marker (which will also run the recovery first start), then re-run this smoke; or
2. Explicitly authorize consuming the first-boot marker as part of this smoke (out of scope here), then re-run.

Until then, ordinary IB would start in a fail-closed, service-suppressed state and cannot satisfy the smoke acceptance criteria.
