# P33 WINDOW SHELL POLISH

Generated: 2026-09-26  
Status: `P33_WINDOW_SHELL_POLISHED`

Scope: Windows Tauri shell only (drag, rounded corners/shadow, credential status wording). Home Node, Vault, credential bridge, recovery lifecycle and the legacy import were **not** modified.

## 1. Window dragging — restored

Audit:
- `tauri.conf.json` window: `decorations:false`, `shadow:false`, `create:false` → the window is a frameless custom-chrome window created in Rust (`WebviewWindowBuilder::from_config`), so there is **no native drag handle**.
- Drag was implemented only in `assets/js/tauri-window-chrome.js`, which creates `#ib-tauri-drag-region` and calls `appWindow.startDragging()` on mousedown. The strip was positioned narrowly between the brand and the nav links: live-measured **26 × 44 px** — practically undiscoverable, so dragging appeared broken.
- Capability `core:window:allow-start-dragging` is present; `window.__TAURI__.window.getCurrentWindow()` exposes `startDragging` / `toggleMaximize` / `onResized` (all available).

Fix:
- Added `data-tauri-drag-region` to `<nav id="navbar">` (the canonical Tauri frameless drag region) so the navbar's non-interactive space drags natively; links and window controls remain clickable.
- Widened the JS strip to the **nav-links → nav-actions** gap (with a brand→links fallback when the navbar is narrow), instead of the old brand→links gap.

Verified live: `#navbar[data-tauri-drag-region] = true`; drag region `pointer-events:auto`. Note: the navbar is tightly packed, so the native draggable area equals the navbar's own empty space; no interactive element was made non-clickable.

## 2. Native rounded corners + shadow

Audit: `decorations:false` + `shadow:false` → the OS frame was square with no shadow; only CSS existed for the in-page chrome.

Fix (native, not CSS-only):
- Added `src-tauri` dependency `windows = { version = "0.61", features = ["Win32_Graphics_Dwm", "Win32_Foundation"] }`.
- New `apply_native_window_rounding(&window)` in `lib.rs` calls, for the main window after `show()`:
  `DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, &DWMWCP_ROUND, 4)` → Windows DWM native rounded corners, so the frame matches the glass UI.
- `tauri.conf.json` window `shadow: false → true` (restores the DWM window shadow).

Verified: compiles and the host runs with the rounded-corner attribute applied. A desktop screenshot was captured at `.yanagent/evidence/window-shell.png`; the configured vision relay is **not available** in this run, so automated visual confirmation of the OS corners/shadow could not be produced — please confirm visually. (The corner rounding is a native DWM attribute, not a CSS radius.)

## 3. Credential-ready UI — simplified

Audit: the ordinary UI surfaces a per-role credential tag from `assets/js/social.js` `_ibApiCredentialStatusLabel()`:
`正在检查凭据状态 · 凭据就绪 · 缺少凭据 · 凭据服务不可用 · 凭据状态未知 · 无需凭据`.

Fix (ordinary UI wording only):
`正在检查 · API 已就绪 · 未连接 · 暂时不可用 · 待确认 · 无需凭据`.

- No `binding` / `resolver` / `authority` / `Vault` terminology is shown in the ordinary UI (verified: none of those terms appear in the home-page DOM text; the old 凭据服务不可用/凭据状态未知 strings are gone from the new labels).
- Details remain available on the Diagnostics page (`#page-diagnostics` / `assets/js/diagnostics.js`).

## Verification

| Check | Result |
|---|---|
| `#navbar[data-tauri-drag-region]` | **true** |
| `#ib-tauri-drag-region` pointer-events | **auto** (strip relocated to nav-links→nav-actions gap) |
| `window.__TAURI__.window` startDragging/toggleMaximize/onResized | **present** |
| DWM rounded corners applied | implementation + build pass (window runs); visual confirmation pending (no vision relay) |
| `shadow` config | **true** |
| API list credential labels simplified | **yes** (`ready → API 已就绪`; old strings removed) |
| `apiConfigs` still load | **13** |
| Runtime crash / exceptions | none |

## Constraints honored

No changes to Home Node, Vault, the credential bridge, recovery lifecycle, or the legacy import. Only window-shell code (`tauri.conf.json`, `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`, `assets/js/tauri-window-chrome.js`, `InternalBeyond.html`) and a credential **display-label** change (`assets/js/social.js`) were touched; the credential status logic/behaviour is unchanged.

## Notes / deviations

- The host was rebuilt with `cargo build --release --features custom-protocol --offline` **without `--locked`** because the new `windows` crate dependency updates `Cargo.lock`. Rebuilt host deployed (sha256 `2d96fcaeda2c8b9b5185658bd5b70a81446f40e592aee91fb317081813251494`).
- Resize remains enabled (`resizable:true`) and untouched; no CSS glass styles were altered, so the glass UI is preserved.

## Final status

`P33_WINDOW_SHELL_POLISHED` — dragging mechanism restored (canonical navbar drag region + widened strip), native DWM rounded corners + shadow added, and credential status wording simplified. Visual confirmation of the OS-level corners/shadow is recommended on the user's side (vision relay unavailable this run).
