# CREDENTIAL-REBIND-R1 BINDING VERIFICATION

Generated: 2026-09-26  
Status: `CREDENTIAL_REBIND_COMPLETE`

## Result

The 13 live `apiConfigs` ids in the RecoveryOnly host's production IndexedDB were resolved through the credential resolver and the Vault binding lookup: **13/13 resolved**, **secret persisted = 0**, **Vault unchanged**. No INSERT was performed (the preflight already found the store populated), no provider call was made, no secret was output, and neither IndexedDB nor the Vault was modified.

This phase performed a read-only verification of the already-present state; it is not an apply.

## Method (read-only)

1. Read the 13 `apiConfigs` ids from the live RecoveryOnly host IndexedDB (`http://tauri.localhost`, `InternalBeyondDB` v24) over CDP. Read-only (`getAllKeys`); no write.
2. For each id, performed the secret-free Vault binding lookup `apiConfig.id → vault.has(bindingId) → status` via `active/credential-authority-adapter.js` (`getCredentialStatus`), which never calls `vault.get()` and returns no secret.
3. Cross-checked each id with the request-scoped resolver `active/credential-resolver.js` **in-process, boolean only** — the resolved `apiKey` was never printed, stored, or returned.
4. Hashed the Vault files before and after.

Host session confirmed: `location.origin = http://tauri.localhost`, `window.__IB_TAURI_HOST__ === true`, `window.__IB_RECOVERY_ONLY__ === true`. The host process was killed after the read (0 stray processes).

## Preflight / host

| Check | Result |
|---|---|
| RecoveryOnly Host active | **PASS** |
| origin = `tauri.localhost` | **PASS** |
| ids read from host | **13** |

## Per-binding results

| # | apiConfig.id | Vault binding (has-only) | resolver (boolean) | credentialRef | provider |
|---:|---|---|---|---|---|
| 1 | `friend_1785224987526` | ready | resolved | `cred-live-4d313f2236c1` | deepseek |
| 2 | `friend_1785251795342` | ready | resolved | `cred-live-0ae2fe61a515` | glm |
| 3 | `friend_1785261242640` | ready | resolved | `cred-live-7e2f2cfcd7a9` | mimo |
| 4 | `friend_1785262029060` | ready | resolved | `cred-live-0e9087f4495c` | deepseek |
| 5 | `friend_1785301791932` | ready | resolved | `cred-live-f0becc1d6285` | glm |
| 6 | `friend_1785302414855` | ready | resolved | `cred-live-08e95850e504` | mimo |
| 7 | `friend_1785309697872` | ready | resolved | `cred-live-20bcfd722af7` | mimo |
| 8 | `friend_1785310595095` | ready | resolved | `cred-live-9d15f721fe7f` | deepseek |
| 9 | `friend_1785411296532` | ready | resolved | `cred-live-067c7b0592f2` | mimo |
| 10 | `friend_1787391487573_1w3xz7` | ready | resolved | `cred-live-6e3ddb088ac7` | deepseek |
| 11 | `friend_1787813887723_w4lxqx` | ready | resolved | `cred-live-8b529b99c400` | deepseek |
| 12 | `friend_1787927183336_epr19a` | ready | resolved | `cred-live-ca173309878e` | mimo |
| 13 | `friend_1788318367937_tcmw0p` | ready | resolved | `cred-live-92275c75aea0` | qwen |

Every `credentialRef` above **matches the frozen plan's `statusOnlyRef` value** for the same config id (`docs/reports/CREDENTIAL-REBIND-R1-PLAN.json`), and every provider matches the frozen `rows[].provider`.

## Totals

| Metric | Value |
|---|---|
| Resolved | **13 / 13** |
| Vault binding status `ready` | **13 / 13** |
| Secret persisted | **0** |
| Provider calls | **0** |
| IndexedDB writes | **0** |
| Vault modified | **no** |

Vault hashes (before = after):

```
credential-vault.json  d82ace3b74a967df570da88521d9563662cc36177224b52fdd728d6225d09bc5
credential-vault.key   15f0466a01d6edfc1a41c53d25d6f98aa169bf90711e48f965cb9eff713a5c5e
```

## Boundaries held

No provider/network call; no secret printed or stored; no IndexedDB write; no change to `apiConfigs`; no Vault mutation; no installer build; no normal IB; no first boot; no R3; no restore of messages / memory / moments. Only read-only probes were issued, and the launched RecoveryOnly host was terminated afterward.

## Conclusion

Each of the 13 live `apiConfigs` ids binds to a present Credential Vault credential whose opaque reference matches the frozen rebind plan. Secret material remained inside the resolver/Vault process boundary and was neither persisted nor emitted. Credential rebind for the 13 frozen configs is **complete and verified**.
