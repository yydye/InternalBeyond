# CREDENTIAL-REBIND-R1 APPLY REPORT

Generated: 2026-09-26  
Status: `BLOCKED_REBIND_APPLY`

## Result

The CREDENTIAL-REBIND-R1 apply was **not executed**. No apiConfigs row was inserted, no production storage was touched, no provider call was made, and no secret was read or written. The frozen 13-row write set remains pending and reversible against checkpoint commit `85f91bef2f2417cf97917585904a696d58a9c511`.

The blocker is structural, not a failed operation: **there is no authorized write path to the production `apiConfigs` store that does not require launching the InternalBeyond product host**, and this task explicitly forbids launching IB / first boot.

## Preflight

| # | Check | Method | Result |
|---|---|---|---|
| 1 | HEAD == `85f91be` | `git rev-parse HEAD` | **PASS** — `85f91bef2f2417cf97917585904a696d58a9c511` |
| 2 | WriteSet hash == `71e4ded9…` | grep of `docs/reports/CREDENTIAL-REBIND-R1-PLAN.json` | **PASS** — value present at lines 1063/1130 of the frozen plan |
| 3 | Vault unchanged | SHA-256 of `%LOCALAPPDATA%/InternalBeyond/credential-vault.{json,key}` | **PASS** — `json` 4166 B `d82ace3b74a967df570da88521d9563662cc36177224b52fdd728d6225d09bc5`; `key` 44 B `15f0466a01d6edfc1a41c53d25d6f98aa169bf90711e48f965cb9eff713a5c5e` — both equal the frozen R1/Vault-audit baseline |
| 4 | Current `apiConfigs` state | read-only inspection of any file-based store | **NOT VERIFIABLE offline** — see blocker; the frozen plan records `apiConfigsCount = 0` (no file store exists in `%LOCALAPPDATA%/InternalBeyond`) |
| 5 | Runtime stopped | process query | **PASS** — no `InternalBeyond` / `ib-host` / release-builder process running |

Frozen plan identity confirmed: target origin `http://tauri.localhost`, database `InternalBeyondDB`, schemaVersion `24`, store `apiConfigs`, planned `INSERT=13 UPDATE=0 DELETE=0`, `secretProjectionCount=0`.

## Blocker: no production `apiConfigs` write path without the host

The production `apiConfigs` collection lives in the **installed app's WebView IndexedDB** (origin `http://tauri.localhost`), and the only code that writes it runs inside that WebView:

| Evidence | Finding |
|---|---|
| `assets/js/core.js` `dbPut` / `dbUpdate` | `s==='apiConfigs'` is written via `IndexedDB` `objectStore('apiConfigs').put(...)` — browser-side only |
| `assets/js/social.js::_persistApiConfig` / `saveCurrentApi` | calls `dbPut('apiConfigs', …)` — browser-side only |
| `src-tauri` command surface | exposed commands are recovery-checkpoint (`read/write_recovery_checkpoint`, `issue_recovery_restore_approval`, `open/close_recovery_apply_window`, `acknowledge_recovery_first_boot`) + project-docs + `credential_status` (has-only) + `credential_resolve` (request-scoped read). **No command writes `apiConfigs`.** |
| Offline/Node apply tooling | none. The only non-WebView `indexedDB.open` calls target the unrelated `IB_LibCache` (`assets/js/workspace/preview.js`, `assets/js/local-first.js`). |
| Archive mirror path | `IB_sync_latest.json` / `IB_backup_*.json` are File-System-Access **exports** granted inside the browser; they are not an IndexedDB load-back path |
| Frozen plan `applyDesign` | `"status": "STOP_BEFORE_APPLY"`, `"applyAllowed": false`, with only the browser-side writer named |
| `docs/P32-W5-INSTALLER-AUTHORITY-UX-UNIFICATION.md` | production apply is hard-closed (`PRODUCTION_APPLY_ENABLED=false`); no production IndexedDB adapter exists |

Consequently an INSERT into the production `apiConfigs` store requires either:

1. the installed product WebView running at `http://tauri.localhost` (i.e. **launch IB** — forbidden by this task's scope and Stop list), or
2. the RecoveryOnly apply window / adapter (**R3-C** — forbidden), or
3. a Tauri write command or offline apply adapter that **does not exist** in the current source.

None of these is available under the frozen scope (`只允许 apiConfigs INSERT 13 条`; 禁止 launch IB / first boot / R3-C / R3-E). The operation therefore stops before apply, consistent with the plan's own `applyAllowed=false` gate.

## Frozen pending write set (not applied)

`INSERT=13` — non-secret projection rows only; no `apiKey` / `imageGenApiKey` / token / secret.

| # | configId (Vault bindingId) | provider | model |
|---:|---|---|---|
| 1 | `friend_1785224987526` | deepseek | deepseek-v4-flash-vision-exp |
| 2 | `friend_1785251795342` | glm | glm-5.3-flash |
| 3 | `friend_1785261242640` | mimo | mimo-v2.5 |
| 4 | `friend_1785262029060` | deepseek | deepseek-v4-flash-vision-exp |
| 5 | `friend_1785301791932` | glm | glm-5.3-flash |
| 6 | `friend_1785302414855` | mimo | mimo-v2.5 |
| 7 | `friend_1785309697872` | mimo | mimo-v2.5 |
| 8 | `friend_1785310595095` | deepseek | deepseek-v4-flash-vision-exp |
| 9 | `friend_1785411296532` | mimo | mimo-v2.5 |
| 10 | `friend_1787391487573_1w3xz7` | deepseek | deepseek-v4-flash-vision-exp |
| 11 | `friend_1787813887723_w4lxqx` | deepseek | deepseek-v4-flash-vision-exp |
| 12 | `friend_1787927183336_epr19a` | mimo | mimo-v2.5 |
| 13 | `friend_1788318367937_tcmw0p` | qwen | qwen3.8-max |

Excluded by design: the 14th Vault-only binding (`friend_1789185068102_ys1n96`, anthropic) has no historical Web Core config (`MANUAL_METADATA_REQUIRED`), and no config is synthesized for it.

## Post-check

Not applicable — zero writes occurred, so there is nothing to re-read.

| Post-check | Result |
|---|---|
| `apiConfigs` count == 13 | **not reached** (0 inserted) |
| `apiKey` count == 0 | trivially true (no write attempted) |
| `imageGenApiKey` count == 0 | trivially true (no write attempted) |
| Vault unchanged | **PASS** (hashes unchanged, see preflight #3) |
| 13/13 config id + Vault binding | **not reached** |
| Provider calls | **0** |

## Safety boundary held

No production write; no IndexedDB / localStorage / sessionStorage write; no Vault mutation or decryption; no Home Node / messages / memory / moments / characters access; no reconstruction; no R3-C / R3-E; no first boot; no Active re-arm; no installer build; no IB launch; no provider or network call; no commit / push. Read-only commands only.

## Unblock conditions

To proceed, one of the following must be authorized as a separate, explicit phase (this phase neither performs nor authorizes it):

1. Authorize launching the product host at the canonical origin and creating the 13 non-secret `apiConfigs` rows through the existing `_persistApiConfig`/`dbPut` boundary (with the first-boot lifecycle gate resolved through its owning phase), or
2. Provide/approve an offline production `apiConfigs` apply adapter with a durable snapshot + rollback, then re-run this apply under that authorization.

The rebind remains fully reversible: checkpoint commit `85f91be` captures the pre-apply source state, the Vault is unchanged, and no row has been written.
