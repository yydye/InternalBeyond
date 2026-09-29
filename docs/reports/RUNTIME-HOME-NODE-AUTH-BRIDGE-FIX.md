# RUNTIME · HOME NODE AUTH BRIDGE FIX

Generated: 2026-09-26  
Status: `RUNTIME_READY_FOR_DATA_RESTORE`

## Result

The canonical Tauri desktop host can now obtain the Home Node desktop credential and the normal runtime is verified end-to-end: the page loads, Home Node writes authenticate, the provider credential resolves, one model request succeeds, and the message persists. The Home Node HTTP admission was **not** widened.

## Phase 1 — read-only audit

1. **`/internal/desktop-credential` auth conditions** (`services/home-node/http.js:718-761`): (a) `isLoopback(req)` — source address must be loopback; (b) `loopbackOrigin(Origin)` — the `Origin` header must match `^https?://(127.0.0.1|localhost|[::1])(:\d+)?$`; (c) `X-IB-Bootstrap: 1` header (keeps it out of the CORS simple-request set); (d) a credential is available and auto-provisioning is on.
2. **`home-node-client.js` fetch** (`assets/js/home-node-client.js:95-154`): explicit `localStorage['ib_home_node_token']` first; else a single `POST /internal/desktop-credential` kept **in memory** (`_sessionToken`); the token is sent on every Home Node request as `X-IB-Home-Token`.
3. **`ib_home_node_token` lifecycle**: localStorage (explicit deployments) → else session-fetched in-memory (never persisted) → else empty, server fails closed 401/403.
4. **Origin classes**: browser (loopback `http://127.0.0.1:23120` or `file://`), Tauri canonical (`http://tauri.localhost`, `custom-protocol` embedded frontend), RecoveryOnly (`http://tauri.localhost/Recovery.html`, command surface restricted).
5. **Existing trusted seam**: `window.__IB_TAURI_HOST__` + the Tauri IPC channel (`withGlobalTauri`); **no** pre-existing Home Node-token seam existed.
6. **Forging `Origin: http://tauri.localhost`**: verified it is **refused** (`403 origin-not-loopback`) — so accepting that origin was never an option.

## Design (minimal, no widening)

The canonical host reaches the credential over the **native Tauri IPC seam**, which browsers and plain HTTP clients cannot invoke. The Home Node endpoint keeps its loopback-only admission unchanged.

- **Native** (`src-tauri/src/lib.rs`): new command `home_node_desktop_credential` (+ `read_home_node_desktop_credential` helper) that reads the Home Node-owned authority file `<LOCALAPPDATA>\InternalBeyond\home-node\desktop-credential.json`, validates `schema == 1` and a usable token (16–512 chars, no trim/control chars), and returns it over IPC. Registered in the **normal** handler only.
- **Client** (`assets/js/home-node-client.js`): `_ibTauriInvoke()` + a Tauri-first branch in `ibHomeNodeProvisionCredential` — under the Tauri host it obtains the credential via the command; the loopback HTTP bootstrap remains the path for browser/loopback pages.

## Additional integration defect found and fixed

`assets/js/host-capability.js` invoked the struct-argument commands **flat**, but both require a `request` object:
- `invoke('credential_status', { bindings: list })` → now `{ request: { bindings: list } }`
- `invoke('credential_resolve', { bindingId: id })` → now `{ request: { bindingId: id } }`

Before this fix the provider credential path always failed (`missing required key request` → `CREDENTIAL_UNAVAILABLE`). Verified directly: nested succeeds (`provider:deepseek`, apiKey present, masked), flat fails.

## Deployment

- Host rebuilt `cargo build --release --features custom-protocol --locked` → deployed to the canonical install root (sha256 `68f2bbe5de836e38d022143ca537cb3435eb3c7fa5637cbd6e47cb9d19e05be0`). Payload manifest left unchanged.
- The installed 1.0.6 payload predated the Credential Bridge, so `active/credential-resolver.js` and `active/credential-resolver-cli.js` were missing; both were deployed into the install root (the release whitelist already stages all of `active/`, so this only closes a stale-install gap).
- `.tauri-frontend` (embedded frontend) synced for both JS edits before the build.

## Tests

| # | Test | Result |
|---|---|---|
| A | Canonical Tauri credential bootstrap | **PASS** — `home_node_desktop_credential` → `{ok:true, source:'tauri-host-bridge', hasCredential:true, len:43}` |
| B | Home Node client has a usable credential | **PASS (session-scoped)** — `provisionedInThisSession:true`, `source:'home-node-bootstrap'`; the localStorage `configured` flag stays `false` **by design** (the token is never persisted) |
| C | Message write not rejected | **PASS** — `POST 127.0.0.1:23118/messages` → **204/200** (was 401 unauthenticated) |
| D | credential resolver | **PASS** — request-scoped `credential_resolve` → `{ok:true, provider:'deepseek'}` (secret masked); has-only `credential_status` → `ready` |
| E | One real model request | **PASS** — single send returned a model reply (`replyText` present, `messageId` assigned) |
| F | Message persistence | **PASS** — `chatMessages` **343 → 345 (+2: user + assistant)** |
| G | Negative tests | **PASS** (below) |

Negative (G):
- plain HTTP client, no `Origin` → `403 origin-not-loopback`, no credential
- plain HTTP client, `Origin: http://tauri.localhost` + `X-IB-Bootstrap: 1` → `403 origin-not-loopback`, no credential
- `Origin: http://evil.example` → `403 origin-denied`, no credential
- loopback Origin without bootstrap header → `400 bootstrap-header-required`
- RecoveryOnly host: `home_node_desktop_credential` → **"Command … not found"**; `credential_resolve` → **"Command … not found"** → RecoveryOnly gains neither the credential bridge nor the provider resolver

Rust: new unit test `home_node_desktop_credential_reads_only_a_valid_authority_file` **PASS** (missing/malformed/short rejected, valid accepted); `cargo check` PASS.

## Constraint compliance

| Rule | Status |
|---|---|
| Do not trust `Origin == http://tauri.localhost` | Endpoint unchanged; that Origin is still refused (verified) |
| Do not make the endpoint unauthenticated | Unchanged (loopback + loopback-Origin + bootstrap header) |
| Do not hardcode / source / output the token | Token only via IPC from the authority file; never printed (length/fingerprint only) |
| Do not change Recovery lifecycle / `ACTIVE_REARM_ENABLED` | Untouched |
| Do not go back to a loopback-served page as the long-term fix | Not done — the canonical `tauri.localhost` page works via IPC |
| RecoveryOnly must not gain normal runtime write | Verified: commands unavailable to RecoveryOnly |
| Do not do R3-B.3 / data restore / Active rearm | Not done |

## Change set

- Modified: `src-tauri/src/lib.rs`, `assets/js/home-node-client.js`, `assets/js/host-capability.js`
- Synced (gitignored): `.tauri-frontend/assets/js/{home-node-client,host-capability}.js`
- Deployed: rebuilt host + `active/credential-resolver{,-cli}.js` into the install root
- Runtime stopped after testing: 0 host processes, 0 service listeners

## Final status

`RUNTIME_READY_FOR_DATA_RESTORE` — the canonical Tauri normal runtime authenticates to the Home Node, resolves provider credentials, and persists messages. No data restore was performed.
