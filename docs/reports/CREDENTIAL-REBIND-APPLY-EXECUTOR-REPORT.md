# CREDENTIAL-REBIND APPLY EXECUTOR REPORT

Generated: 2026-09-26  
Status: `READY_FOR_CREDENTIAL_REBIND_APPLY`

## Result

Implemented a minimal, recovery-only-scoped **CredentialRebindExecutor** that inserts the frozen 13-row `apiConfigs` WriteSet into the RecoveryOnly host's WebView IndexedDB. It is a thin add-on that reuses the existing RecoveryOnly host and the shared Web Core schema module; it does not create a new recovery system and does not enable any other apply.

The executor is synthetically verified (11/11). The **production WebView apply was not executed** in this turn because it requires launching the InternalBeyond host (forbidden here); the executor is ready to run inside an authorized RecoveryOnly host session.

## Deliverables

| File | Change |
|---|---|
| `assets/js/credential-rebind-executor.js` | **new** — `CredentialRebindExecutor` + frozen WriteSet validator (UTF-8 BOM, project convention) |
| `tests/test_credential_rebind_executor.js` | **new** — synthetic in-memory IndexedDB contract tests (11 checks) |
| `Recovery.html` | modified — one line: load `credential-rebind-executor.js` in the RecoveryOnly host page |
| `docs/reports/CREDENTIAL-REBIND-APPLY-EXECUTOR-REPORT.md` | this report |

## Design

```
frozen WriteSet validation (assertWriteSet)
        ↓
   preflight: RecoveryOnly host gate + target empty (apiConfigs count == 0)
        ↓
WebView IndexedDB scoped transaction (store: apiConfigs only, readwrite)
        ↓
   INSERT 13 non-secret rows (objectStore.add, never put/update)
        ↓
transaction failure → abort (atomic rollback) → CREDENTIAL_REBIND_FAILED_ROLLED_BACK
success → readback verify → on mismatch: delete inserted keys → rollback
```

- **Host reuse:** trust is granted only when `window.__IB_TAURI_HOST__===true && window.__IB_RECOVERY_ONLY__===true` (mirrors `recovery-apply-executor.js`), plus an origin check against `http://tauri.localhost`. The page is otherwise inert.
- **Frozen WriteSet binding:** `assertWriteSet` requires `hash === 71e4ded9…`, `operations === {INSERT:13,UPDATE:0,DELETE:0}`, exactly 13 rows, unique ids, `id === vaultBindingId`, `secretProjected !== true`, and recomputes `sha256(JSON.stringify(sorted(ids)))` against the frozen `75ed7e4984df9b67f65f92408d359135465dae64d634c20770d3103d039c2de8`.
- **Secret firewall:** the blocked-key set mirrors `assets/js/core.js::_ibCredentialFreeApiConfig` (`apiKey|api_key|imageGenApiKey|image_gen_api_key|authorization|bearer|accessToken|refreshToken|token|secret|password`, recursive). Any secret field **fails the write set**; a defensive projection also strips them before insert.
- **No Vault / no provider:** the module contains no `vault.*`, `credential-vault`, `fetch`, `XMLHttpRequest` or `WebSocket` call; the only URL literal is the frozen target origin. Secrets are never read or written.

## Verification

| Check | Result |
|---|---|
| `node --check assets/js/credential-rebind-executor.js` | **PASS** |
| `node --check tests/test_credential_rebind_executor.js` | **PASS** |
| `node tests/test_credential_rebind_executor.js` | **11 / 11 PASS** (synthetic in-memory IndexedDB) |
| `node tests/test_credential_bridge_r1.js` | **PASS** (`CREDENTIAL_BRIDGE_R1_SYNTHETIC_PASS`) — bridge unaffected |
| `node tests/test_frontend_structure.js` | **16 failures = pre-existing baseline** (unchanged); new asset passes `encoding.validUtf8` / `encoding.bom` / `encoding.noMojibake` |
| `tests/test_recovery_only_host_contract.js` | fails at line 73 on an unrelated `src-tauri/src/lib.rs` assertion — **pre-existing** (`lib.rs` untouched, `git status` empty for it); Recovery.html check-conditions verified manually: all forbidden substrings absent, required recovery modules present |
| Release manifest (`release-manifest.resolve`) | includes `Recovery.html` **and** `assets/js/credential-rebind-executor.js` (ships in canonical whitelist) |

Synthetic executor test coverage (all passing):

1. 13 frozen ids recompute to the frozen config-id-set hash
2. WriteSet rejects wrong hash / UPDATE / DELETE / count / duplicate id / secret field / wrong id-set
3. secret detection + projection strip forbidden keys at depth
4. host gate refuses without the RecoveryOnly marker
5. origin gate refuses a non-`tauri.localhost` origin
6. preflight requires an empty target and reports count 0
7. happy path: 13 inserted, readback verified, 0 secrets
8. non-empty target refused (no UPDATE/DELETE)
9. transaction failure aborts atomically, 0 rows remain
10. post-commit verify failure triggers delete rollback to 0 rows
11. `verify()` reports missing ids; `rollback()` deletes only given keys

Acceptance numbers (**synthetic target**, in-memory IndexedDB):

```
planned inserts   = 13
actual inserts    = 13
secret persisted  = 0
provider calls    = 0
Vault hash        = unchanged
```

Vault (fresh, unchanged): `credential-vault.json` `d82ace3b74a967df570da88521d9563662cc36177224b52fdd728d6225d09bc5` · `credential-vault.key` `15f0466a01d6edfc1a41c53d25d6f98aa169bf90711e48f965cb9eff713a5c5e`.

## Scope invariants enforced

| Rule | Enforcement |
|---|---|
| INSERT only (13) | `operations.UPDATE===0 && operations.DELETE===0`; only `add()` is ever called |
| No secret fields | recursive blocked-key scan fails the run; projection strips before insert |
| No `apiKey` / `imageGenApiKey` / token / secret | included in blocked-key set |
| No Vault mutation | module never references the Vault |
| No Home Node / messages / memory / moments / characters | only `apiConfigs` store is transacted |
| Empty target required | `preflight`/`execute` refuse when `apiConfigs` is non-empty |
| Transaction failure → rollback | scoped IndexedDB abort is atomic; post-commit verify failure deletes inserted keys |
| Success → readback verify | every expected id present, count 13, 0 secret fields |

## How to run the apply (authorized RecoveryOnly host session)

1. Open the RecoveryOnly host page (`Recovery.html`) — the executor loads automatically.
2. Build the WriteSet from the frozen plan rows (`docs/reports/CREDENTIAL-REBIND-R1-PLAN.json`) with the source-bound metadata values, `hash=71e4ded9…`, `operations={INSERT:13,UPDATE:0,DELETE:0}`.
3. `new IBCredentialRebindExecutor.CredentialRebindExecutor({ writeSet })` → `await preflight()` → `await execute('执行 CREDENTIAL-REBIND-R1 apiConfigs 13 条 INSERT')`.
4. Report `{planned:13, actual:13, secretPersisted:0, providerCalls:0}`.

## Limitation

The real production `apiConfigs` write was **not** performed: the target is the installed app's WebView IndexedDB at `http://tauri.localhost`, reachable only from a running RecoveryOnly host session, and launching the host / first boot is out of scope for this turn. The acceptance numbers above are from the synthetic in-memory target that exercises the identical code path. No host was launched, no production IndexedDB was opened, no Vault was read, and no provider/network call was made.
