# CREDENTIAL-REBIND-R1 PRODUCTION APPLY REPORT

Generated: 2026-09-26  
Status: `BLOCKED_REBIND_PRODUCTION_PREFLIGHT`

## Result

The production apply was **not executed**. Preflight reached the live RecoveryOnly host and read the production `apiConfigs` store directly, and found it **not empty**: it already contains exactly the frozen 13 rows. Per the stated rule — *"确认 apiConfigs 当前为空。如果不是空：停止，不覆盖"* — the apply stopped before any write. No INSERT was performed, no overwrite occurred, no secret was written, and the Vault was not touched.

## Preflight (live, read-only)

Method: launched the installed host at `%LOCALAPPDATA%\Programs\InternalBeyond\internalbeyond-host.exe --recovery-only` with the documented WebView2 debugging seam (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>`), attached via CDP to the `http://tauri.localhost/Recovery.html` target, and evaluated read-only probes. The host process was killed after each probe.

| # | Check | Evidence | Result |
|---|---|---|---|
| 1 | RecoveryOnly Host active | CDP page target `http://tauri.localhost/Recovery.html`; `location.origin === 'http://tauri.localhost'`; `window.__IB_TAURI_HOST__===true`; `window.__IB_RECOVERY_ONLY__===true` | **PASS** |
| 2 | origin = `tauri.localhost` | `location.origin === "http://tauri.localhost"` | **PASS** |
| 3 | `apiConfigs` empty | `InternalBeyondDB` v24, store present, **count = 13**; ids = the frozen set; secret fields in rows = 0 | **FAIL — non-empty** |
| 4 | Vault hash unchanged | `credential-vault.json` `d82ace3b74a967df570da88521d9563662cc36177224b52fdd728d6225d09bc5`; `credential-vault.key` `15f0466a01d6edfc1a41c53d25d6f98aa169bf90711e48f965cb9eff713a5c5e` | **PASS** |
| 5 | WriteSet hash unchanged | `71e4ded955b90823d4530f59c5c16827a4245ad5759b1b7bc6b9809f7896171b` | **PASS** |

Current production `apiConfigs` ids (read-only, exactly the frozen set):

```
friend_1785224987526  friend_1785251795342  friend_1785261242640  friend_1785262029060
friend_1785301791932  friend_1785302414855  friend_1785309697872  friend_1785310595095
friend_1785411296532  friend_1787391487573_1w3xz7  friend_1787813887723_w4lxqx
friend_1787927183336_epr19a  friend_1788318367937_tcmw0p
```

Secret fields present in the stored rows: **0** (`apiKey` / `imageGenApiKey` / `token` / `secret` all absent).

## Decision

Preflight condition #3 (empty target) failed → **stop, no overwrite**. This is also enforced by the executor itself: `CredentialRebindExecutor.execute()` refuses a non-empty target (`credential-rebind-target-not-empty`) and only ever calls `add()`. No INSERT, UPDATE or DELETE was issued.

## Apply

Not executed.

| Item | Value |
|---|---|
| actual inserts | **0** |
| write transaction opened | **no** |
| rollback status | n/a (nothing written; no rollback needed) |
| transaction status | n/a (no write transaction) |
| secret fields written | **0** |
| provider calls | **0** |

## Post-verification (read-only)

| Check | Result |
|---|---|
| `apiConfigs` count | **13** |
| 13/13 frozen ids present | **YES** |
| secret fields in stored rows | **0** |
| Vault unchanged | **YES** (`d82ace3b…`, `15f0466a…`) |
| WriteSet hash unchanged | **YES** (`71e4ded9…`) |

Note: the desired end state (13 frozen ids present, 0 secret fields) is **already present** in production. The R1 plan recorded `currentCanonicalCount = 0` on 2026-09-25; the store now holds the 13 rows (this matches the plan's own recorded `HISTORICAL_PROJECTION_DISCREPANCY`). No rebind INSERT is therefore required; a separate authorized phase would be needed to verify the live configs' Vault binding rather than to insert rows.

## Failure policy

Honored: on the failed preflight the apply stopped, **did not retry**, and did not enter any other recovery path.

## Boundaries held

No installer build; **no normal IB** launch; no first boot (the `--recovery-only` branch returns before `HostLifecycle`, services and launcher); no R3 / reconstruction; no restore of messages / memory / moments. Only `apiConfigs` was read, and only read-only probes were issued. The launched host process was terminated after every probe (verified: 0 stray `InternalBeyond` processes). HEAD remains `85f91bef2f2417cf97917585904a696d58a9c511`.

## Evidence artifacts

Read-only driver scripts used for the live preflight are under `.yanagent/rebind/` (removed after this report). Executor implementation from the prior phase: `assets/js/credential-rebind-executor.js`, tests `tests/test_credential_rebind_executor.js`.

## Next step

No insert is needed because the target already equals the frozen WriteSet. Before declaring the rebind complete, an explicitly authorized verification phase should confirm that the 13 live configs resolve their Vault binding (request-scoped, secret-free) — this report makes no such claim.
