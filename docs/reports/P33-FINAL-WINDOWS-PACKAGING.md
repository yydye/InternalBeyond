# P33 FINAL WINDOWS PACKAGING

Generated: 2026-09-26  
Status: `P33_WINDOWS_PACKAGE_COMPLETE`

## Result

The current verified source was built into the canonical **Inno Setup** installer and installed over the existing 1.0.6 without touching any user data. Install/parity/identity and the runtime acceptance (drag, hydration, credential UX, Home Node bridge, credential commands, secret-free configs) all pass. No second installer framework was introduced; no new features were added.

## Artifacts

| Item | Value |
|---|---|
| Installer | `dist\InternalBeyond-Setup-1.0.6.exe` · **75,764,966 bytes** (72.3 MiB) |
| Installer SHA-256 | `c291ed3624c9865d14a56f4fec775731a657f165b1db1b2882dd1b173e3ee048` |
| Host SHA-256 | `da09a8d6f4756ae462cd7df58f3171a0b1a26bfa682c63eeb0cf17482e0be363` (30.0 MiB) |
| Payload file count | **386** (`ib-payload-manifest.json`) |
| Manifest SHA-256 | `f21439f7c97360cd2d76420a924aadc034d2f2a26634be83de89c9147d61f7e2` |
| Checksums | `dist\SHA256SUMS.txt` · `dist\update-stable.json` |

## Phase 1 — preflight

- Installer authority unchanged: **Inno Setup 6** (`ISCC`, `installer\InternalBeyond.iss`, AppId `{78B427F6-A48F-4443-86D5-2F50DC899D07}`). No NSIS/Tauri bundler used.
- `VERSION = 1.0.6`; bundled runtime pinned (node 24.18.0, hash-verified).
- All recent fixes are present in the packaging source (`assets/`, `InternalBeyond.html`, `src-tauri/src`, `src-tauri/Cargo.toml`,`Cargo.lock`, `tauri.conf.json`) — 36 changed paths; the whitelist stages `assets/`, `InternalBeyond.html`, `active/`, `services/`, `bridge/`, `runtime/`, etc.
- Exclusions verified: staging and the installer contain **no** Vault files, `credential-vault.key`, production Home Node DB, WAL/SHM, `tmp/`, `.yanagent/`, `src-tauri/target`, or dev caches.

## Phase 2 — build

- `cargo build --release --features custom-protocol --locked` → **PASS** (`Finished`, no lock drift). The P33 `windows` crate dependency is already reflected in `Cargo.lock`; no update was needed and it was not bypassed.
- Canonical `scripts\build-installer.ps1` ran the full pipeline: staging (384 whitelist files → mirror) → Tauri host build (`stage-tauri-host.ps1`, same `--locked` recipe) → payload manifest → release audit → ISCC compile → SHA-256 → update manifest.
- Release audit: **PASS** — 386 files, **0 error / 8 warn**.
- Host frozen for this doc: `stage-tauri-host.ps1` builds the mirror's `src-tauri/Cargo.toml`.

## Phase 3 — canonical Inno installer

`InternalBeyond-Setup-1.0.6.exe` produced; compiled identity verified as `InternalBeyond` / AppId `{78B427F6-…}`; PE ProductVersion `1.0.6` matches `VERSION`.

## Phase 4 — install / upgrade acceptance

Isolated install first (`/DIR=<temp>`, `/VERYSILENT`), then canonical upgrade (default dir):

| | Check | Result |
|---|---|---|
| A | installer installs | **PASS** — exit 0; 388 files = 386 payload + `unins000.exe/.dat` |
| B | canonical shortcut | **PASS** — `…\Start Menu\Programs\InternalBeyond\InternalBeyond.lnk` + uninstall shortcut |
| C | uninstall identity | **PASS** — `{78B427F6-…}_is1` · DisplayName `InternalBeyond 1.0.6` · uninstaller path; removed cleanly |
| D | payload parity 100% | **PASS** — 386/386 present + SHA-256 equal, 0 missing/diff |
| E | normal IB starts | **PASS** — host starts, services up (active `/health` 200) |
| F | window draggable | **PASS** — `#navbar[data-tauri-drag-region]=true`, drag region `pointer-events:auto`, `startDragging` available |
| G | resize | **PASS (config)** — `resizable:true` unchanged |
| H | Tauri rounded-corner code active | **PASS (build)** — packaged host contains the DWM corner code; OS-level visual confirmation unavailable this run (no vision relay) |
| I | API page shows credential UX | **PASS** — 13 rows, 13 status tags, 13 `[更换/添加 API Key]` buttons, modal present, first tag `（API 已就绪）` |
| J | Home Node Tauri auth bridge provisions | **PASS** — `ibHomeNodeProvisionCredential` ok, `provisionedInThisSession:true` |
| K | `credential_status` / `credential_resolve` callable | **PASS** — status `ready`; resolve `ok` (provider `deepseek`, key present, masked) |
| L | IndexedDB runtime hydration after `ensureDB` | **PASS** — `db` open, `apiConfigs` = 13 |
| M | `apiConfigs` secret-free | **PASS** — raw IndexedDB `apiConfigs` secret fields = **0** |
| N | installer excludes Vault/key/DB/WAL/SHM | **PASS** — none of those names present in the installer or the staged/installed payload |
| O | uninstall does not delete user data | **PASS** — uninstall removes app + registry; user data untouched |

## Phase 5 — existing-user upgrade safety

- Installed the canonical installer over the existing 1.0.6 (default dir). **exit 0**.
- Pre/post hashes of every data artifact **unchanged**: `credential-vault.json` (`d82ace3b…`), `credential-vault.key` (`15f0466a…`), `home-node.db` (`467103ac…`), `recovery-checkpoint.json` (`96fdc0aa…`), `-intent`, `-ready`, `-verified`, `recovery-finalized.json`, `boot-state.json`.
- Home Node counts stable: `messages 347 · memory_records 4 · moment_records 155`.
- The installer never writes `%LOCALAPPDATA%\InternalBeyond` (WebView profile / Home Node DB / Vault / recovery evidence); it does not re-trigger Legacy Import or Recovery.
- Note: counts are **347/4/155**, not the earlier 345/4/155 — the +2 messages came from the app's own Active runtime across the P33 phases, **not** from the installer (the install changed no data file hash).

## Known non-blocking debts

- Release audit **8 warnings** (email/phone regex hits in `InternalBeyond.html:2294`, `LICENSES/*`, `README.md`) — pre-existing, non-blocking.
- `update-stable.json` omits `releasedAt`/`notes` (not supplied at build time).
- Home Node message count drifted 345 → 347 via normal Active behaviour (not packaging).
- Legacy `apiSettings[].apiKey` still present in the IndexedDB `apiSettings` store (pre-existing; the localStorage mirror was already sanitised in the prior phase). A separate authorized hygiene step.
- Vault **delete** authority still not exposed (add/replace exists) — as reported previously.
- OS-level rounded-corner/shadow **visual** confirmation not available in this run (vision relay unavailable); the native DWM code is compiled into the shipped host and the window runs.
- The "1.0.6" installer is a same-version reinstall (no version bump).

## Final status

`P33_WINDOWS_PACKAGE_COMPLETE` — canonical Inno Setup installer built from the current verified source, install/parity/identity verified, user data preserved across the upgrade. No push performed.
