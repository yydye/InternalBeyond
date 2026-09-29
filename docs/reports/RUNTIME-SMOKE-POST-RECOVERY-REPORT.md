# RUNTIME SMOKE (POST-RECOVERY) REPORT

Generated: 2026-09-26  
Status: `BLOCKED_RUNTIME_SMOKE`

## Result

Normal IB launched and the runtime came up healthy, and the page / role config / credential resolver all verified. The smoke **failed at the message send and message-save steps**: the Home Node write is rejected as `unauthenticated`, because the desktop credential cannot be obtained from the `tauri.localhost` page origin (Home Node returns `403 origin-not-loopback`) and no token is otherwise configured. No message was persisted (`chatMessages` stayed at 341), and no provider call was made. No data was restored.

## Step results

| # | Step | Result |
|---|---|---|
| 1 | Start normal IB | **PASS** — host running; `boot-state.json` `overall: normal`, `ok: true`; static 23120 / bridge 23115 / active 23114 / homeNode 23118 / restart 23116 all `healthy` |
| 2 | Page load | **PASS** — `http://tauri.localhost/InternalBeyond.html?ib_tauri_host=1`, title "Internal Beyond", `window.IB` populated, 33 IndexedDB stores |
| 3 | Role config read | **PASS** — 13 `apiConfigs` loaded (`loadApiConfigs`), e.g. `friend_1785224987526` 弗洛洛 / deepseek, `friend_1785251795342` 初音未来 / glm, … ; no `apiKey`/`imageGenApiKey` present in any row |
| 4 | Send test message (single role) | **FAIL** — `Home Node 写入被拒绝（unauthenticated）`; outbound `POST http://127.0.0.1:23118/messages` rejected; no provider request observed |
| 5 | Credential resolver works | **PASS** — native `credential_status` from the live host returned `status:"ready"`, `secretPresent:true`, `credentialRef` `cred-live-4d313f2236c1` / `cred-live-0ae2fe61a515` / `cred-live-7e2f2cfcd7a9` (matches the frozen rebind refs) |
| 6 | Message save path | **FAIL** — `chatMessages` count 341 → 341 (unchanged); no new user/assistant message persisted |

## Root cause

- The Home Node desktop-credential endpoint `POST http://127.0.0.1:23118/internal/desktop-credential` returns **`403 {"ok":false,"error":"origin-not-loopback","hint":"this path is for the desktop page served from a loopback origin","originSeen":"present-but-not-loopback"}`**.
- The page origin is `http://tauri.localhost` (the Tauri `custom-protocol` asset origin), which is **not** a loopback origin, so the client cannot fetch the Home Node credential.
- `IB.ibHomeNodeCredentialState()` → `configured:false`, `source:null`, `provisionedInThisSession:false`; `ibHomeNodeEffectiveToken` is empty → the message write is sent with an empty credential and the server fails closed (`401 unauthenticated`).
- `assets/js/home-node-client.js` documents the intended flow: Home Node self-issues the credential and the **loopback-served** desktop page fetches it once (in-memory only). The Tauri `tauri.localhost` shell therefore cannot provision it, and `ibHomeNodeProvisionCredential()` fails with `home-node-credential-unavailable / origin-not-loopback`.

## What held

- No data restore; no R3-B.3; no messages/memory/moments/character projection; no Active rearm; `ACTIVE_REARM_ENABLED` untouched.
- No partial write: the store count is unchanged (341) and no message was created.
- No secret was output; `credential_status` is has-only.
- Runtime stopped after the smoke: 0 `internalbeyond-host.exe` processes, 0 listeners on 23114/23115/23116/23118/23120/8765.

## Unblock conditions (hypotheses for a later, authorized phase)

1. **Serve the desktop page from a loopback origin** in the Tauri host (load `http://127.0.0.1:23120/InternalBeyond.html` in the WebView instead of the embedded `tauri.localhost` asset), so the Home Node credential fetch is accepted; or
2. Have the launcher/host **provision and inject** `ib_home_node_token` into the page session (the documented explicit-config path), so Home Node writes authenticate without the loopback bootstrap; or
3. Accept the loopback-origin requirement in the Home Node policy for the canonical desktop origin (`tauri.localhost`) at the owning layer.

Each of these is a code/config change owned by the Tauri host / Home Node integration, not by this smoke phase.

## Final status

`BLOCKED_RUNTIME_SMOKE` — runtime services and the credential resolver are functional, but the message send/save path is blocked by the Home Node desktop-credential origin policy for the `tauri.localhost` page. Not ready for data restore until the Home Node write path authenticates.
