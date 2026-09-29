# P33 API CREDENTIAL MANAGEMENT UX

Generated: 2026-09-26  
Status: `P33_API_CREDENTIAL_UX_COMPLETE`

## Result

Added a clear, in-context entry to **add / replace** an API Key for each credential-bearing API config, reusing the **existing** Credential Vault authority. No credential architecture was redesigned; the Vault remains the only secret authority; `apiConfigs` stays secret-free. **Remove credential** is reported as a missing capability (no exposed Vault delete authority) rather than hacked in.

## Audit (read-only)

| Area | Finding |
|---|---|
| API config editor | `social.js::saveCurrentApi` is **secret-free by design** — if a key is typed it clears the field and refuses: "API 凭据由 Credential Vault 管理；此表单不会保存或导入密钥。" The `api-key`/`api-imagegen-apikey` inputs are "vault-managed" placeholders. |
| `credential_status` | native command → `active/credential-authority-adapter-cli.js`, **has-only** (no secret). Used by the API list tag. |
| `credential_resolve` | native command → `active/credential-resolver-cli.js`, request-scoped secret. Unchanged. |
| Vault write/replace | **Exists**: `active/credential-vault.js` exposes `upsert(characterId, {provider, apiKey, endpoint, model})` (AES-256-GCM at rest) and `remove()`. |
| Exposed write seam | **Exists**: `active/http.js:222` `POST /credentials` → `credentialVault.upsert(...)`; body `{credentials:[{characterId, provider, apiKey, endpoint, model}]}`; returns `{ok,stored}`; never echoes the key. Active-service `originAllowed()` includes `isTauriOrigin` → the Tauri page may call it. Frontend client: `_activeCompanionRequest('/credentials', …)`. |
| Vault delete seam | **Missing**: `vault.remove()` exists but **no** route or native command exposes it (the adapter explicitly never calls it). |
| New-config key flow | The editor already creates secret-free configs; the key is expected to come from the Vault authority. |

## Implementation

Entry: per-row action in the existing API list (`#api-list-container`).
- `API 已就绪` (remote endpoint) → **[更换 API Key]**
- needs key / not connected → **[添加 API Key]**

Modal (glass-consistent, matches the app): title (更换 / 添加 API Key) · Provider · 当前配置 · **新的 API Key** (`type=password`, starts empty, `autocomplete=off`) · note "API Key 将保存在本地加密凭据存储中，不会写入角色配置。" · [取消] [保存]. The old key is never read, echoed or fetched.

Write boundary on 保存:
```
apiConfig.id → existing binding (id) → POST /credentials → credentialVault.upsert(id, {provider, apiKey, endpoint, model})
```
then `renderApiList()` re-runs `credential_status`. No `cfg.apiKey = …`; no IndexedDB / localStorage / sessionStorage secret write.

Files: `assets/js/social.js` (button + modal + save), `InternalBeyond.html` (modal markup), `assets/css/core.css` (styles), `assets/js/core.js` (mirror hygiene, below). Synced to `.tauri-frontend`; host rebuilt + deployed (`60bce964a7b393e8b1dee5fcc61b2f100a51337d997c0302b24288dc75cb92c6`).

## Tests

| # | Test | Result |
|---|---|---|
| 1 | 13 configs still display | **PASS** — 13 rows, 13 status tags, 13 key buttons |
| 2 | Old secret never read/displayed | **PASS** — modal key input starts empty; `type=password`; no fetch of an existing key |
| 3 | Synthetic key updates via Vault authority | **PASS** — sandbox: `upsert/has/get`, encrypted at rest, `remove` → `VAULT_AUTHORITY_OK`; UI save posts `{characterId, provider, apiKey, endpoint, model}` to `/credentials` |
| 4 | `apiConfigs` secret fields = 0 | **PASS** — raw IndexedDB `apiConfigs` secret fields = **0** |
| 5 | IndexedDB / localStorage / sessionStorage secret persistence = 0 | **PASS (after mirror fix)** — sessionStorage 0; IndexedDB `apiConfigs` 0; localStorage `ib_mirror_v1` secret **removed** (0 matching keys). |

| 6 | `credential_status` correct | **PASS** — tags render per config (`（API 已就绪）`). |
| 7 | Resolver path unchanged | **PASS** — `credential_resolve` untouched; `apiConfigs`=13; no provider-path change. |
| 8 | Cancel modal writes nothing | **PASS** — cancel closes the modal with **0** POSTs. |

Synthetic fixture used (`sk-synthetic-FIXTURE-*`); the production Vault was never written during testing (the save path was exercised with an intercepted fetch; the authority was proven in a temp-dir sandbox).

## Mirror hygiene fix (finding)

The audit found a **pre-existing** legacy secret: `localStorage['ib_mirror_v1'] → .stores.apiSettings[3].apiKey` (a 57-char `sk-…`). `core.js::_ibMirrorPack` sanitised `apiConfigs` only. Fixed `_ibMirrorPack` to also sanitise `apiSettings`, then forced a mirror rewrite → the mirror now contains **0** secret patterns. The same legacy `apiSettings[].apiKey` still exists in the **IndexedDB `apiSettings` store** (legacy data, not produced by this phase); removing it is a data mutation left to a separate, explicitly-authorized hygiene step.

## Remove credential — capability missing

The Vault module has `remove()`, but **no exposed delete authority** (no route, no native command). Per the task's rule, no temporary bypass was added. **Recommendation**: authorize a separate phase to expose a bounded, confirmed Vault delete (e.g., `DELETE /credentials` reusing `credentialVault.remove`, with二次确认 in the UI) — then add the `[移除凭据]` action (confirm-gated, secret-only, never deleting `apiConfig` metadata).

## Constraints honored

No changes to Home Node, Recovery, R3, legacy import, Active, character projection or Windows shell; credential architecture unchanged (the existing `/credentials` upsert authority is reused; no second Vault). No real key used; no secret emitted.

## Final status

`P33_API_CREDENTIAL_UX_COMPLETE` — add/replace API Key UX implemented on the existing Vault authority; secret persistence for the new flow is 0; the Vault **delete** authority is missing and reported.
