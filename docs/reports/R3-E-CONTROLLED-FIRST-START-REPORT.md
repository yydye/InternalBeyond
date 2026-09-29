# R3-E CONTROLLED FIRST START REPORT

Generated: 2026-09-26  
Status: `BLOCKED_FIRST_BOOT`

## Result

Preflight passed, but the **controlled first start was not executed**. Consuming the first-boot marker does **not** bring up the normal runtime: the host's boot policy is non-`Normal` for *both* `FirstBootPending` **and** `ActiveQuarantine`, and `suppress_services()` is true for any non-`Normal` mode. So after consuming the marker the Bridge / Home Node / Active services would still be suppressed, and the required smoke (items 2, 3, 4, 7) cannot pass. The marker was therefore **not consumed** — it is an irreversible production lifecycle mutation that would not achieve the phase goal. Ordinary IB was not launched and no provider call was made.

## Preflight (read-only) — PASS

| Check | Result |
|---|---|
| Checkpoint file hash | `recovery-checkpoint.json` = `96fdc0aa099b955b5f1a3e4b17e7c0e154babe901fb63b89786f706d8ebdfadf`; **matches** the recorded `checkpointFileSha256` in `recovery-checkpoint-ready.json` |
| Verified marker | present; `schema: internalbeyond.recovery-checkpoint-verified`, `version 1`, `planId` matches, `verifiedAt: unix-ms:1790234711196` |
| planId alignment | `checkpoint == verified == ready == intent` → `r3b3:1ee6aba8f773b8297e25a3904bad0f9db51ec308e4d295a1718ae48912cf44c7` |
| Target identity | `com.internalbeyond.desktop\|canonical-inno\|[local path redacted]|1.0.6\|4403403d7ce7e514d995ffb1b043e1be264dfc67f47a1c21ac9d2dc24c695d8b` (unchanged) |
| Target | origin `http://tauri.localhost`, database `InternalBeyondDB`, schemaVersion `24` |
| Checkpoint phase | `PREPARED`; `firstBootPending: true`, `activeQuarantined: true` |
| Consumed marker | **absent** |
| Credential resolver | **13 / 13 resolved**; adapter `vault.has` 13/13 `ready`; secret persisted **0** |
| Vault | unchanged (`d82ace3b…` / `15f0466a…`, identical before/after) |

## Blocker: consuming the marker does not enable the normal runtime

Source evidence (`src-tauri/src/lib.rs`):

- `RecoveryBootPolicy::suppress_services()` → `self.mode != RecoveryBootMode::Normal` (line 496–498). **Any** non-`Normal` mode suppresses services.
- `recovery_boot_policy_from_dir` (line 1930–2033): valid checkpoint + valid verified marker + **no** consumed marker → `mode = FirstBootPending`; with a valid consumed marker → `mode = ActiveQuarantine`. There is **no** transition back to `Normal` from consumption.
- Services start only when the policy is `Normal`: `lib.rs:5221` `if !recovery_policy.suppress_services() { spawn_existing_launcher(&lifecycle); }`. Under both `FirstBootPending` and `ActiveQuarantine`, the launcher (and thus static/bridge/active/homeNode/restart) is **not** spawned.
- `assets/js/recovery-first-boot.js::resolvePolicy` returns `suppressServices: true` for both `FIRST_BOOT_PENDING` **and** the post-consume `ACTIVE_QUARANTINE`.
- Active cannot be re-armed in this build: `ACTIVE_REARM_ENABLED = false` (`recovery-first-boot.js:13`); `requestExplicitActiveRearm` returns `active-rearm-disabled-in-r3b3.2`.

Consequence: after consuming, mode = `ACTIVE_QUARANTINE` → services still suppressed → smoke items **2 (Bridge), 3 (Home Node), 4 (Active service), 7 (single chat)** are unreachable. Reaching them requires the policy to return to `Normal`, which needs the recovery checkpoint to be cleared/finalized (a rollback/finalize authority, out of scope here) — not merely consuming the first-boot marker.

## Controlled First Start — not executed

| Step | Status |
|---|---|
| Consume first-boot marker | **Not executed** (would only reach `ACTIVE_QUARANTINE`; services stay suppressed) |
| Start normal runtime services | **Not executed** (blocked by the policy above) |
| Smoke 1. page load | Not executed |
| Smoke 2. Bridge | Not executed |
| Smoke 3. Home Node | Not executed |
| Smoke 4. Active service | Not executed |
| Smoke 5. apiConfigs | Not executed (13 rows already verified present in prior phase) |
| Smoke 6. Vault resolver | Not executed this phase (13/13 verified in preflight) |
| Smoke 7. single chat smoke | Not executed (would also require a provider call) |

| Metric | Value |
|---|---|
| First-boot marker consumed | **no** |
| Ordinary IB launches | **0** |
| Services started | **0** |
| Provider calls | **0** |
| IndexedDB / Vault / Home Node writes | **0** |
| Data restored (messages/memory/moments/characters) | **0** |

## Boundaries held

No first-boot marker consumption; no ordinary IB launch; no runtime services; no provider call; no IndexedDB, Vault or Home Node writes; no R3-C; no R3-D; no Active data restore; no provider migration; no messages/memory/moments restore. No secret was output. Preflight was read-only; the Vault is unchanged and no stray `InternalBeyond` process is running.

## Unblock conditions

The normal runtime can start only when `recovery_boot_policy_from_dir` returns `RecoveryBootMode::Normal`, i.e. the recovery checkpoint and its lifecycle/verified/consumed markers are cleared. That is a checkpoint finalize/rollback authority, not the first-boot consumption this phase authorized. Options for a later, explicitly authorized phase:

1. **Finalize the recovery lifecycle** (clear the checkpoint + markers) so a normal start returns `Normal` and enables services; or
2. Complete the remaining recovery phases (R3-C / R3-D / R3-E data + Active re-arm) and then clear the checkpoint, so the runtime comes up in the intended post-recovery state.

Until one of those is authorized, a normal launch will start in a fail-closed, service-suppressed state (`FirstBootPending`, then `ActiveQuarantine`), which cannot satisfy the runtime smoke acceptance criteria. Stopping here — not proceeding into data restore.
