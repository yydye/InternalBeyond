# P32-W.4 · Runtime Authority Reconciliation

日期：2026-09-22（Asia/Shanghai）  
阶段：Phase A-D read-only audit only

P32-W.4 当前状态：**BLOCKED / DEGRADED — reconciliation identified, repair not started**。

本轮没有修改代码、没有 build、没有 install、没有 upgrade、没有 restart、没有 uninstall，也没有删除任何安装或用户数据。Credential Authority 仍停在 R10.2 BLOCKED；本阶段没有继续 R10/R11。

不变量：

- Credential writes：0。
- Credential secret reads：0；只读取 credential 文件 metadata，没有读取内容。
- Provider calls：0。
- Active business-data writes：0。
- 未执行任何 `_up_` patch 或 workspace-to-installed copy。

## A. Scope

本轮只完成：

1. Windows runtime/install authority reconstruction。
2. `_up_` live-root provenance 与 root-resolution 根因审计。
3. P32-W frozen contract reconciliation。
4. canonical target architecture 定义。

本轮不执行 Phase E 之后的 root-resolution repair、runtime identity implementation、build、install、upgrade、shortcut takeover 或 stale-install cleanup。

## B. Runtime Authority Graph

### B1. Workspace/development graph

```text
E:\InternalBeyond-main
  ├─ src-tauri/ + Cargo/Tauri dev host
  ├─ .tauri-frontend/  ← build.rs 生成的 HTML hard link + asset junctions
  ├─ runtime/launch-internal-beyond.js
  ├─ runtime/local-services-runner.js
  └─ services/* + active/* + Web Core
```

证据：

- `src-tauri/tauri.conf.json:5-9`：Tauri dev URL 是 `http://127.0.0.1:23120/InternalBeyond.html`，`frontendDist` 是 `.tauri-frontend`。
- `src-tauri/build.rs:37-72`：`.tauri-frontend` 由 workspace `InternalBeyond.html` 和 `assets/active/apps/game` 的 link 构成，不复制第二套源码。
- `src-tauri/src/lib.rs:659-712`：debug build 使用 `development_root()`，即 workspace root；`IB_PROJECT_ROOT` 也只在显式提供且 payload 形状满足时生效。

分类：development only。workspace shortcut `[local path redacted]` 当前指向 `E:\InternalBeyond-main\InternalBeyond.html`，不是 production shortcut。

### B2. Tauri package/NSIS acceptance graph

```text
workspace source
  → cargo/tauri build
  → src-tauri/target/release/bundle/nsis
  → Tauri current-user install [local path redacted]
       ├─ internalbeyond-host.exe
       ├─ uninstall.exe
       └─ _up_\  ← Tauri resource tree
             ├─ InternalBeyond.html
             ├─ runtime/
             ├─ services/
             ├─ active/
             └─ assets/...
```

证据：

- `src-tauri/tauri.conf.json:29-58`：NSIS、current-user install、Start Menu folder、resources `docs/README/VERSION/InternalBeyond.html/assets/apps/game/runtime/services/bridge/active`。
- Generated `src-tauri/target/release/nsis/x64/installer.nsi:629-700`：resources 被写入 `$INSTDIR\_up_`，包括 `active/persistence.js` 与 `services/active-message-service.js`。
- `docs/P32-W2-INSTALLER-AUTHORITY-CONVERGENCE.md:87-100,280-296`：`_up_` 是 Tauri acceptance resource tree，不是 canonical Inno production payload。

分类：acceptance/package artifact only。当前机器却有 Tauri registry identity 和正常入口指向它，因此 acceptance runtime 实际承担了用户运行入口。

### B3. Canonical Inno production graph

```text
root VERSION
  → scripts/release-manifest.js whitelist
  → scripts/build-installer.ps1
       ├─ payload staging
       ├─ release audit
       ├─ stage-tauri-host.ps1 → one internalbeyond-host.exe
       └─ Inno compile
  → InternalBeyond-Setup-<version>.exe
  → Existing Inno install root
       ├─ internalbeyond-host.exe
       ├─ InternalBeyond.html / assets / docs
       ├─ runtime/ / services/ / active/ / bridge/
       ├─ tools/ib-stop.js
       ├─ 启动 InternalBeyond.vbs
       └─ ib-payload-manifest.json
```

证据：

- `docs/history/release/RELEASE_PIPELINE_AUDIT.md:27-98`：root `VERSION`、唯一 build command 和 9-step pipeline。
- `scripts/release-manifest.js:6-22,43-79`：whitelist-only source payload；当前 read-only resolve 为 `entries=41, count=354, missing=0, denied=0`。
- `scripts/build-installer.ps1:361-420`：staging 与 payload manifest；`scripts/build-installer.ps1:374-384` 明确 host 是唯一 generated production input，不消费 `_up_`。
- `installer/InternalBeyond.iss:68-117,135-169`：Inno identity、payload copy、Start Menu/Desktop/Run/UninstallRun contract。
- `scripts/stage-tauri-host.ps1:4-9,59-75,101-119`：host build mirror 只用于 build，最终只把一个 host EXE 交给 Inno。

分类：canonical production authority。

### B4. Current runtime graph

```text
Desktop/Start Menu InternalBeyond.lnk
  → [local path redacted] (PID 17168)
  → project_root() / launcher_root()
  → [local path redacted]
  → [local path redacted] (PID 23928)
  → [local path redacted] (PID 13376)
```

Process/boot evidence：

- Host PID 17168，executable `[local path redacted]`。
- Runner PID 23928，PPID 21152，command line 指向 `_up_\runtime\local-services-runner.js`。
- Active PID 13376，PPID 23928，command line 指向 `_up_\services\active-message-service.js`。
- Active listener `127.0.0.1:23114`，health HTTP 200。
- `[local path redacted]`：`launcher.root = [local path redacted]`，version `1.0.6`，overall `normal`。
- `host-bootstrap-trace.json`：current executable 是 `[local path redacted]`，唯一存在 launcher/UI/docs 的 candidate 是 `_up_`。

分类：当前用户实际使用的 runtime；但不是 canonical Inno production runtime。

### B5. Updater and browser/VBS graph

- Updater：`services/internal-beyond-server.js` 的 update surface → `runtime/update-install.js` → `%LOCALAPPDATA%\InternalBeyond\updates` → verified Inno EXE → Inno controlled stop/install/relaunch。`runtime/update-install.js:9-18,41-45,789-890`。
- Browser/VBS fallback：`启动 InternalBeyond.vbs:145-148` → root-local bundled Node → `runtime/launch-internal-beyond.js` → Browser/static Web。它是 fallback/legacy入口，不应成为 Tauri production shortcut authority。
- 当前 Start Menu/desktop normal shortcut 并未指向 VBS；它们指向 Tauri host，形成 authority collision。

## C. Installed Runtime Provenance

### C1. Registry identities

| Registry record | Current value | Classification |
|---|---|---|
| `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\InternalBeyond` | DisplayName `InternalBeyond`; version `1.0.6`; install `[local path redacted]`; uninstall `uninstall.exe` | Tauri NSIS installed identity; currently active |
| `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\{78B427F6-A48F-4443-86D5-2F50DC899D07}_is1` | DisplayName `InternalBeyond 1.0.6`; install `[local path redacted]`; uninstall `unins000.exe` | Existing Inno identity; separate root |
| `HKCU\Software\InternalBeyond\InternalBeyond` | default path `[local path redacted]` | Tauri previous-install-location key |

Both identities use the same visible product name but different installer ownership, install roots and uninstall semantics. No matching HKLM production entry was found.

### C2. Shortcuts

Read-only shortcut inspection found:

| Shortcut | Target | Meaning |
|---|---|---|
| `[local path redacted]` | `[local path redacted]` | current Tauri host entry |
| `[local path redacted] Menu\Programs\InternalBeyond\InternalBeyond.lnk` | `[local path redacted]` | current Tauri host entry; collides with Inno visible name |
| `...\InternalBeyond\卸载 InternalBeyond.lnk` | `[local path redacted]` | Inno uninstall shortcut |
| `[local path redacted]` | `E:\InternalBeyond-main\InternalBeyond.html` | development/browser shortcut; not production |

The current ordinary launch shortcut is therefore Tauri-owned. It does not prove that Tauri is canonical; it proves that the stale/acceptance identity is the one the user currently launches.

### C3. Installed payload evidence

Current Tauri root:

- `[local path redacted]` contains only `internalbeyond-host.exe`, `uninstall.exe` and `_up_`.
- `_up_` has no `ib-payload-manifest.json`.
- `_up_` has no VBS fallback or `tools/ib-stop.js`.
- Installed `_up_\active\persistence.js` is 5,042 bytes and lacks R10.1; installed `_up_\services\active-message-service.js` is 29,420 bytes and lacks R10.1.

Current Inno root:

- `[local path redacted]` exists, product version `1.0.6`, count `308`.
- Its manifest contains VBS, `tools/ib-stop.js`, `active/persistence.js` and `services/active-message-service.js`, but **does not contain `internalbeyond-host.exe`**.
- The installed Inno `active/persistence.js` is the old 5,042-byte copy; it does not contain R10.1.
- The existing `dist/update-stable.json` and `InternalBeyond-Setup-1.0.6.exe` were produced on 2026-09-17, before the current workspace host/R10.1 changes.

The machine therefore has a Tauri live acceptance runtime and a separate old/incomplete Inno 1.0.6 runtime. Neither current tree proves the post-P32-W.2 host-integrated canonical payload.

## D. Why `_up_` Became Live

### D1. Host root resolution

`src-tauri/src/lib.rs` is the direct root-resolution authority:

- `has_product_payload()` at lines `690-696` checks only `InternalBeyond.html` and `runtime/launch-internal-beyond.js`.
- `project_root()` at lines `698-754` checks `IB_PROJECT_ROOT`, debug workspace root, then `process_exe_dir`, `exe_dir`, `resource_dir`, parents and several `_up_` candidates.
- `project_root()` does not require `ib-payload-manifest.json`, does not verify canonical Inno identity and does not carry an explicit `runtimeMode`.
- `launcher_root()` at lines `795-817` repeats a root/`_up_` candidate search based only on the presence of `runtime/launch-internal-beyond.js`.
- `spawn_existing_launcher()` at lines `850-905` launches the selected root’s Node/launcher without distinguishing production from acceptance.

### D2. Exact current resolution

For the current Tauri install:

1. `current_exe()` / executable dir = `[local path redacted]`.
2. That directory has the host and uninstall executable but not `InternalBeyond.html` or `runtime/launch-internal-beyond.js`.
3. Tauri `resource_dir()`/resource layout exposes the copied resource tree under `_up_`.
4. `_up_` has `InternalBeyond.html` and `runtime/launch-internal-beyond.js`.
5. The weak `has_product_payload()` test succeeds for `_up_`.
6. `spawn_existing_launcher()` starts `_up_\runtime\launch-internal-beyond.js` with `_up_` as current directory.
7. The launcher computes its own `ROOT = path.resolve(__dirname, '..')`, so runner and all services resolve from `_up_`.

The persisted `host-bootstrap-trace.json` is direct runtime evidence of this candidate selection: state root `_up_`, current EXE at the parent install root, and no valid launcher/UI/docs candidate at the parent root.

### D3. Root-cause classification

This is multi-factor, not a single filesystem accident:

| Factor | Evidence | Result |
|---|---|---|
| Acceptance install used as normal user install | Tauri uninstall key + host shortcut + live PID | **CONFIRMED** |
| Installation identity mismatch | Tauri product-name uninstall key and Inno GUID `_is1` coexist | **CONFIRMED** |
| Packaging layout mismatch | Tauri generated NSIS writes resources under `_up_`; Inno expects root payload | **CONFIRMED** |
| Silent root-resolution fallback | `project_root()`/`launcher_root()` accept `_up_` by weak two-file marker and no mode | **CONFIRMED** |
| Shortcut collision | Start Menu/Desktop `InternalBeyond.lnk` targets Tauri host; Inno uninstall link targets other root | **CONFIRMED** |
| Updater directly wrote `_up_` | update code and current metadata do not support this | **NOT EVIDENCED** |
| Workspace was directly copied to `_up_` in this phase | no; hard boundary preserved | **NOT DONE** |

The primary operational cause is: **a Tauri acceptance installation became the user-facing installation, and production host root resolution silently accepted its `_up_` resource tree because no positive canonical payload marker or explicit mode was required**.

## E. Frozen Contract Matrix

| Contract | Expected frozen authority | Current reality | Drift? | Repair needed? |
|---|---|---|---|---|
| A. Production installer | Existing Inno | Tauri NSIS registry identity is the currently launched install; Inno exists separately | Yes | Canonical takeover through Inno; no deletion in this phase |
| B. Production install root | Inno-owned root; default `%LOCALAPPDATA%\Programs\InternalBeyond` | Inno record points to `[local path redacted]`; Tauri record points to `[local path redacted]` | Yes on this machine | Safe migration/takeover plan required |
| C. Host artifact | Stable host staged by `stage-tauri-host.ps1`, then installed by Inno | Live host is Tauri NSIS host; current Inno manifest lacks host | Yes | Rebuild/current artifact and install through Inno |
| D. Web Core | Canonical Inno root payload | Live Web Core is `_up_`; Inno Web Core is a separate old copy | Yes | Resolve root only after positive production marker |
| E. runtime/services payload | Canonical Inno root | Active/runner/services all come from `_up_` | Yes | Production root validation and canonical installation |
| F. Launcher | Canonical root’s launcher; VBS remains fallback | Tauri Host launches `_up_` launcher; VBS is not normal shortcut | Yes | Explicit production/acceptance/dev modes |
| G. Updater | Existing updater downloads verified Inno EXE and lets Inno replace payload | Source updater still follows this contract; current Tauri install is not its target | Authority intact; current install drift | Keep updater Inno-mediated |
| H. Uninstall | Inno `unins000.exe` + `ib-stop.js` | Tauri `uninstall.exe` is current registry identity; Inno uninstaller remains separate | Yes | Canonical takeover; preserve stale install until safe cleanup contract |
| I. VERSION | Repository root `VERSION` | All observed copies report `1.0.6`; physical payloads are different/stale | Byte/payload drift | Rebuild through one VERSION authority |
| J. Browser/VBS fallback | Browser/VBS fallback, not a second production install | VBS exists only in Inno root; current shortcut uses Tauri host; workspace HTML shortcut also exists | Yes | Restore one canonical shortcut; retain VBS fallback role |
| K. Acceptance bundle | Tauri NSIS `_up_`, explicit acceptance only | Tauri `_up_` is being used as ordinary production runtime | Yes | Mark mode/identity; keep `_up_` acceptance-only |

The frozen decisions themselves are consistent: `docs/P32-W2-INSTALLER-AUTHORITY-CONVERGENCE.md:239-257,403-417` states Existing Inno is the only production installer/updater/uninstaller and Tauri NSIS is development/packaging acceptance only. The current machine has not reached that physical convergence.

## F. Canonical Target Architecture

The target graph, without introducing a new authority, is:

```text
Canonical source + root VERSION
        │
        ▼
release-manifest.js whitelist
        │
        ▼
build-installer.ps1
  ├─ release audit
  ├─ stage-tauri-host.ps1 → one stable internalbeyond-host.exe
  └─ Inno compile
        │
        ▼
Canonical Inno install root
  ├─ internalbeyond-host.exe
  ├─ InternalBeyond.html / assets / Web Core
  ├─ runtime/ + bundled Node
  ├─ services/ + active/ + bridge/
  ├─ tools/ib-stop.js + VBS fallback
  └─ ib-payload-manifest.json
        │
        ▼
Production Host (Tauri WebView shell)
        │
        ▼
canonical-root runtime/launch-internal-beyond.js
        │
        ▼
canonical-root runtime/local-services-runner.js
        │
        ├─ canonical-root services/active-message-service.js
        ├─ canonical-root services/ib-bridge-service.js
        └─ canonical-root services/home-node-service.js
```

Separate non-production graphs remain explicit:

```text
Tauri acceptance build
  → Tauri NSIS
  → host.exe + _up_ resource tree
  → runtimeMode=acceptance

Tauri dev
  → devUrl / workspace .tauri-frontend
  → runtimeMode=development
```

Production must not resolve runtime/services from `_up_`. `_up_` may remain an acceptance resource root only when the mode is explicit and positively identified.

## G. Root Resolution Contract

Phase A-D only defines the repair contract; it does not implement it.

### Production installed Host

1. Resolve the executable’s canonical install root.
2. Require positive payload identity, not just directory existence:
   - `ib-payload-manifest.json` with expected schema/version;
   - root `VERSION` and product version consistency;
   - `internalbeyond-host.exe`;
   - `InternalBeyond.html`;
   - bundled Node;
   - launcher, runner and service files declared by the manifest.
3. Do not silently fall back to `_up_`.
4. If the canonical marker is absent, fail closed with bounded `RUNTIME_PAYLOAD_INVALID` diagnostics.

### Acceptance Host

- `_up_` is allowed only under explicit acceptance mode/identity.
- Acceptance root must project `runtimeMode=acceptance` and `runtimeRootClass=tauri-resource`.
- Acceptance must not write production installer/update identity or become the normal shortcut target.

### Development Host

- workspace/dev root is allowed only under debug/dev mode.
- `devUrl` and workspace `.tauri-frontend` remain development surfaces.

The current `has_product_payload()` two-file predicate is not sufficient for the production contract.

## H. Runtime Identity

No new identity store was created. The existing `%LOCALAPPDATA%\InternalBeyond\boot-state.json` remains the diagnostic authority (`docs/P32-W-WINDOWS-TAURI-PRODUCTIZATION.md:23-25`).

Required future projection, using the existing boot-state/diagnostic surface, is:

- `runtimeMode`: `production | acceptance | development`;
- `runtimeRootClass`: `canonical-inno | tauri-resource | workspace`;
- product version;
- host version;
- payload manifest version/identity;
- runner root;
- service root(s).

It must not contain credential, user-data content or arbitrary filesystem enumeration.

## I. `_up_` Boundary

Frozen interpretation: `_up_` is a Tauri acceptance resource tree. It is not a production data authority, installer authority, updater target or normal production runtime root.

Current violation: the normal Start Menu/Desktop InternalBeyond shortcut launches a Tauri Host whose root resolver selects `_up_`; the live runner and Active both come from `_up_`.

Required boundary after a future approved repair:

- production shortcut: never `_up_`;
- production updater: never writes `_up_` directly;
- production runner/services: never default to `_up_`;
- acceptance: may use `_up_` only with explicit mode and identity;
- development: may use workspace/dev root only with explicit mode.

## J. Tauri NSIS Boundary

Tauri NSIS remains development/package acceptance only. It must not become the canonical production installer, updater target, normal shortcut authority or production uninstall authority.

Current machine classification:

- `[local path redacted]` = **ACTIVE_ACCEPTANCE_INSTALL / stale authority collision**: current Tauri NSIS identity, current shortcuts and live Host.
- `[local path redacted]` = **STALE_OR_INCOMPLETE_INNO_INSTALL**: Inno identity exists, but current payload manifest lacks `internalbeyond-host.exe`.
- `E:\InternalBeyond-main\InternalBeyond.html.lnk` = **DEVELOPMENT_SHORTCUT**: workspace Browser entry.

No installation was deleted. Safe cleanup recommendation: preserve both installations until a registry-isolated canonical takeover is designed, user-data boundary is snapshotted, and the existing installer contract proves that cleanup cannot touch user data or the other identity.

## K. Existing Installation Migration

### K1. Primary data-root evidence

The primary runtime/user data root is outside both install roots:

`[local path redacted]` contains metadata entries for:

- `active-message-service.json` and `.bak`;
- `credential-vault.json` and `credential-vault.key`;
- `home-node/`;
- `bridge/`;
- `boot-state.json`;
- `logs/`, `updates/`, update cache and observation state.

Source evidence:

- `services/active-message-service.js:28-32` → `%LOCALAPPDATA%\InternalBeyond`.
- `active/credential-vault.js:19-20` → vault files under the injected data dir.
- `services/ib-bridge-service.js:32-35` → `%LOCALAPPDATA%\InternalBeyond\bridge`.
- `services/home-node-service.js:111-114` → `%LOCALAPPDATA%\InternalBeyond\home-node`.
- `runtime/local-services-runner.js:85-88` → `%LOCALAPPDATA%\InternalBeyond\logs`.

The current Tauri WebView profile is separately located at `[local path redacted]`, consistent with the known Browser/Tauri origin split.

### K2. Install-root state requiring caution

The Inno root `[local path redacted]` exists. It is runtime-generated log state under an install root, not a credential authority, but it is still a preservation/ownership concern for any future takeover. Therefore actual canonical install/upgrade is **not authorized by this audit**.

Primary credential/business data appears separated from the install payload by source and metadata evidence, but the install-root log boundary is not yet closed. No migration, copy or deletion was attempted.

## L. User Data Boundary

| Data class | Observed authority | Current boundary | P32-W.4 result |
|---|---|---|---|
| Active state | `%LOCALAPPDATA%\InternalBeyond\active-message-service.json` | outside install roots | metadata-only confirmed; no read/write |
| Vault | `%LOCALAPPDATA%\InternalBeyond\credential-vault.*` | outside install roots | metadata-only confirmed; no content read |
| Bridge state | `%LOCALAPPDATA%\InternalBeyond\bridge` | outside install roots | metadata-only/source confirmed |
| Home Node DB | `%LOCALAPPDATA%\InternalBeyond\home-node` | outside install roots | metadata-only/source confirmed |
| Boot/log/update state | mostly `%LOCALAPPDATA%\InternalBeyond` | outside payload, except Inno-root logs also exist | migration not authorized |
| Tauri WebView profile | `%LOCALAPPDATA%\com.internalbeyond.desktop\EBWebView` | separate Tauri origin | no storage migration |
| Workspace `.tauri-frontend` | workspace build artifact | development only | not user data |

No user data was read or migrated in Phase A-D.

## M. Host Resolution Repair

Not implemented in this phase. Required minimal direction:

- strengthen production marker validation;
- add explicit mode/identity projection;
- remove silent production `_up_` fallback;
- retain `_up_` only for explicit acceptance;
- fail closed with bounded diagnostic when canonical payload is absent;
- keep existing launcher/runner/service ownership unchanged after root selection.

This is an infrastructure repair, not a credential-specific hack and not a privileged Active endpoint.

## N. Release Manifest Closure

Current workspace read-only resolution:

- source manifest: `entries=41`;
- resolved files: `354`;
- missing: `0`;
- denied: `0`.

The source manifest includes `active/` and `services/active-message-service.js` (`scripts/release-manifest.js:67,74`), so `active/persistence.js` and the R10.1 Active composition-root file are eligible for a future canonical build without credential-specific packaging rules.

Current installed convergence is not proven:

- Tauri `_up_` has no canonical `ib-payload-manifest.json`.
- Current Inno payload manifest is old 1.0.6 count 308 and lacks `internalbeyond-host.exe`.
- Current live Active is from Tauri `_up_`, not from the Inno root.

## O. Canonical Build

Not executed. The only permitted future build command remains:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-installer.ps1
```

No Tauri NSIS build, manual zip, manual copy, direct installed-file replacement or second installer authority was used in this phase.

## P. Install/Upgrade Acceptance

Not executed by P32-W.4. Any future canonical takeover must first:

1. snapshot current processes, registry identities, shortcuts and payload metadata;
2. preserve `%LOCALAPPDATA%\InternalBeyond` and relevant install-root logs;
3. use Inno’s root-scoped stop/lifecycle contract;
4. install/upgrade only through the canonical Inno path;
5. verify both identities and user data after completion.

## Q. Live Process Verification

Current live verification is intentionally a finding, not a pass:

| Process | PID | Root |
|---|---:|---|
| Tauri Host | 17168 | `[local path redacted]` |
| Local services runner | 23928 | `[local path redacted]` |
| Active | 13376 | `[local path redacted]` |
| Bridge | 28732 | `[local path redacted]` |
| Home Node | 21764 | `[local path redacted]` |
| Static server | 21752 | `[local path redacted]` |

The live processes are healthy enough to run, but they all prove the current authority drift: service roots are `_up_`, not canonical Inno.

## R. R10.1 Writer Verification

R10.1 writer presence in the current live payload: **FAIL / absent**.

- Workspace `active/persistence.js` contains the R10.1 writer.
- Current Tauri `_up_\active\persistence.js` does not.
- Workspace `services/active-message-service.js` contains the R10.1 seam.
- Current Tauri `_up_\services\active-message-service.js` does not.
- Current old Inno `active/persistence.js` also does not.

No transaction was called. P32-W.4 only reconciles payload authority; it does not resolve R10.2 authentication.

## S. Acceptance Regression

Not executed after this read-only audit. Existing P32-W docs record Tauri asset/host acceptance, but the current machine’s installed payload and shortcut provenance show that acceptance install is currently used as the normal launch path. A future acceptance rerun must assert `runtimeMode=acceptance` and must not alter production registry/shortcut authority.

## T. Browser/VBS Regression

Not executed. Static/source evidence remains:

- VBS exists in the Inno root and is in the canonical Inno whitelist.
- VBS invokes bundled Node and `runtime/launch-internal-beyond.js` (`启动 InternalBeyond.vbs:145-148`).
- VBS is not the current normal shortcut target.
- Workspace HTML shortcut is development-only and is not a production fallback.

## U. Update/Uninstall Regression

Not executed. Static contract remains:

- updater downloads and verifies Inno installer, not JS and not `_up_` (`runtime/update-install.js:9-18,41-45,874-890`);
- Inno `PrepareToInstall` calls root-scoped `ib-stop.js` (`installer/InternalBeyond.iss:387-468`);
- Inno uninstall invokes the stop helper (`installer/InternalBeyond.iss:171-175`);
- Tauri NSIS has a separate uninstall identity and is not allowed to become production updater/uninstaller authority.

## V. Production Invariance

P32-W.4 Phase A-D invariance:

- Credential writes: 0。
- Credential secret reads: 0。
- Provider calls: 0。
- Vault contents unchanged。
- Active state contents unchanged。
- Bridge/Home Node data contents unchanged。
- Memory/Relationship/Activity/Diary/Moments/Role Letters unchanged。
- Registry and shortcut state was read only; no takeover/cleanup occurred。
- Current processes were not stopped, restarted or killed。

## W. Tests

The following were intentionally not run because the user explicitly constrained this turn to Phase A-D read-only audit:

- root-resolution repair tests;
- new runtime identity tests;
- build/installer tests;
- fresh install/upgrade/uninstall;
- shortcut takeover;
- P32-W regression rerun;
- R10.1 installed-payload rerun.

Existing 7 BOM failures remain outside this phase and were not touched.

## X. Credential Authority Resume Gate

| Gate | Current result |
|---|---|
| production installer authority = Inno | Contract PASS; current user launch identity still Tauri |
| production runtime root = canonical Inno root | FAIL: live root is `_up_` |
| production Host does not depend on `_up_` | FAIL: current Host selects `_up_` |
| Active live owner from canonical root | FAIL: PID 13376 is `_up_` |
| R10.1 writer in installed payload | FAIL: absent from current Tauri and old Inno payloads |
| live owner loaded R10.1 | FAIL |
| acceptance `_up_` isolated from production | FAIL on current machine: normal shortcut uses it |
| updater remains installer-mediated | Contract PASS; no update executed |
| user data unchanged | PASS for this read-only phase |
| credential data unchanged | PASS; no secret content read |
| provider calls = 0 | PASS |
| no new regression failures | NOT EXECUTED |

### Final summary

```text
Production installer authority: Existing Inno (frozen contract)
Production install root: Inno-owned root; current registry root [local path redacted] is stale/incomplete 1.0.6
Production runtime root: not currently achieved; live runtime root is [local path redacted]
Host runtime mode: current live install behaves as acceptance/resource mode, but is not explicitly identified
Runner root: [local path redacted]
Active root: [local path redacted]
Bridge root: [local path redacted]
`_up_` production dependency: current live dependency; forbidden by frozen contract
Tauri NSIS role: acceptance/package only; currently colliding with normal user install identity
Canonical shortcut: should be Inno-installed internalbeyond-host.exe; current shortcut points Tauri host
R10.1 writer in installed payload: no
Live owner loaded R10.1: no
User data changes: 0 in this phase
Credential writes: 0
Credential secret reads: 0
Provider calls: 0
Unexpected business-data changes: 0
Existing stale installation: Tauri acceptance install [local path redacted] plus old/incomplete Inno install [local path redacted]
Credential deployment blocker: R10.2 remains blocked; P32-W.4 does not implement privileged auth
P32-W.4 status: BLOCKED / DEGRADED after Phase A-D; repair not started
```

P32-W.4 到此停止。不要继续 R10.2、R10 Retry #2、R11、credentialRef production write、Active privileged auth、cleanup、Backup v2、Storage Convergence、Developer Mode、Jev 或 Android。不 commit，不 push。

# P32-W.4A Canonical Takeover Preparation

日期：2026-09-22（Asia/Shanghai）  
范围：workspace-side preparation only；真实安装/进程/registry/shortcut 仍 read-only

P32-W.4A 当前状态：**DEGRADED / PREPARED FOR NEXT BUILD GATE**。

本阶段完成了 runtime mode contract、production positive identity、fail-closed root-resolution repair、runtime identity projection、install-root log ownership repair、user-data boundary audit 和 cross-installer takeover state-machine design。尚未 build installer、运行 installer、执行 fresh install/upgrade/uninstall 或真实 takeover，因此不能宣布 P32-W.4A PASS。

## A. Scope

已执行：

- 修改 workspace Host/launcher/boot-state source。
- 新增 P32-W.4A workspace contract test。
- 修复 launcher runtime log future ownership。
- 只读确认 release manifest/build ordering、用户数据根和安装 identity。
- 设计 isolated E2E 与 P32-W.4B runbook boundary。

未执行：

- 没有写 `[local path redacted]`。
- 没有写 `[local path redacted]`。
- 没有写真实 registry、shortcut、`%LOCALAPPDATA%\InternalBeyond`、Vault 或 Active state。
- 没有停止、重启或 kill 当前 live IB。
- 没有 credential migration、Active privileged auth、R10/R11 或 provider call。

## B. Runtime Mode Implementation

`src-tauri/src/lib.rs` 现在定义显式三态 runtime mode：

| Mode | Root class | Selection contract |
|---|---|---|
| `production` | `canonical-inno` | release default；只允许 Host executable dir / Tauri executable dir 中的 positive Inno payload |
| `acceptance` | `tauri-resource` | 只在 `IB_RUNTIME_MODE=acceptance` 显式指定时允许 `_up_`/resource root；可选 `IB_ACCEPTANCE_ROOT` 明确指定 isolated root |
| `development` | `workspace` | debug build 默认；`IB_PROJECT_ROOT` 只在 debug/development mode 允许 |

Release Host 不再接受 `IB_PROJECT_ROOT` 重定向到 workspace；release build 请求 development mode 会返回 bounded `RUNTIME_MODE_INVALID`。

## C. Production Payload Identity

production mode 不再使用 `InternalBeyond.html + runtime/launch-internal-beyond.js` 的 weak predicate。

`src-tauri/src/lib.rs` 增加 positive payload validation，要求：

- `ib-payload-manifest.json` 存在且 schema 为 `internalbeyond.payload-manifest`；
- manifest version 为 `1`，count 与 file list 一致且没有重复；
- manifest product、根 `VERSION` 与 Host package version 一致；
- `internalbeyond-host.exe` 存在并被 manifest 声明；
- `InternalBeyond.html`、bundled Node、launcher、runner、Active、Bridge、Home Node、`active/persistence.js` 等 required files 存在且被 manifest 声明；
- `tools/ib-stop.js` 与 VBS fallback 被 manifest 声明；
- payload identity 使用 manifest bytes 的 structural SHA-256，仅用于 bounded diagnostics，不读取 user data/credential。

当前旧 Inno root 的 manifest 会因 Host 缺失而 fail closed；当前 Tauri `_up_` 会因 manifest 缺失而不被当作 production。

## D. Root Resolution Repair

已重构 `project_root()` 路径为 explicit `resolve_runtime_root()`：

### Production

只检查 executable root，不再遍历 parent、resource parent 或 `_up_`。canonical marker/required payload 缺失时直接返回：

```text
RUNTIME_PAYLOAD_INVALID
```

不会 fallback 到 `_up_`、workspace、Browser 或 partial services。

### Acceptance

只在显式 `IB_RUNTIME_MODE=acceptance` 下检查 Tauri resource/`_up_` candidates；Host 启动 launcher 时会向 child 传递：

- `IB_RUNTIME_MODE=acceptance`；
- `IB_RUNTIME_ROOT_CLASS=tauri-resource`。

### Development

debug build 使用 workspace/debug root；`IB_PROJECT_ROOT` 保留为 development-only override。

`launcher_root()` 与 `spawn_existing_launcher()` 不再自行寻找另一个 parent/`_up_` candidate，而是只使用已经通过 mode-specific validation 的 `HostLifecycle.root`。

## E. Acceptance Boundary

Tauri `_up_` 仍被保留为 acceptance resource layout，但现在必须显式 mode 才可使用。Acceptance 不会被声明为 production，boot-state 会投影：

```text
runtimeMode = acceptance
runtimeRootClass = tauri-resource
```

当前真实 Tauri install 没有被重新启动来验证该 mode；后续 acceptance E2E 必须在 isolated root/ports/data/registry/shortcut 条件下执行，不能复用 `[local path redacted]`。

## F. Development Boundary

workspace dev contract 保持：

- `cargo tauri dev` / debug build；
- `devUrl`；
- `.tauri-frontend` HTML hard link + asset junctions；
- `runtimeMode=development`、`runtimeRootClass=workspace`。

production/release Host 不接受 `IB_PROJECT_ROOT`，避免 workspace 被当成 production runtime authority。

## G. Runtime Identity Projection

没有创建第二 runtime-state store。现有 `%LOCALAPPDATA%\InternalBeyond\boot-state.json` 的 `launcher.runtime` projection 现在包含：

- `runtimeMode`；
- `runtimeRootClass`；
- `productVersion`；
- `payloadManifestVersion`；
- `payloadIdentity`；
- `hostRoot`；
- `runnerRootClass`；
- `serviceRootClass`。

Identity 只记录 bounded root/manifest metadata，不记录 credential、Vault、Active state 内容或 arbitrary directory listing。

## H. Release Manifest Closure

workspace `scripts/release-manifest.js` read-only resolve 仍为：

```text
entries=41
count=354
missing=0
denied=0
```

manifest 自然包含：

- `active/`，因此包含 `active/persistence.js`；
- `services/active-message-service.js`；
- runtime、services、bridge、bundled Node、VBS、`tools/ib-stop.js`。

Host 不作为 source whitelist entry，而由 `stage-tauri-host.ps1` 生成后由 `build-installer.ps1` 加入最终 staging/manifest；该 frozen build contract 未改变。

## I. Payload Manifest Closure

未运行 installer，但 source ordering 已验证：

1. whitelist staging；
2. `stage-tauri-host.ps1` 写入 `internalbeyond-host.exe`；
3. build script 将 Host 和 `ib-payload-manifest.json` 加入最终 file list；
4. manifest 写入 staging；
5. Inno compile 使用该 staging。

新增 contract test 确认 active/persistence、Active service、Host 和 payload manifest 的 source/build ordering。实际 final artifact/install manifest 等待下一阶段 canonical build gate。

## J. Install-Root Logs Ownership

审计发现：

- `runtime/launch-internal-beyond.js` 原先将 launcher log 写入 `{installRoot}\logs`；
- `runtime/local-services-runner.js` 已使用 `%LOCALAPPDATA%\InternalBeyond\logs`；
- Inno `runtime-invalid.txt` 属于 installer transient diagnostic，不是运行时 launcher log。

已将 launcher runtime log 改为：

```text
%LOCALAPPDATA%\InternalBeyond\logs\launcher.log
```

当前旧 Inno root 的既有 `logs/` 未读取、未迁移、未删除。未来 policy：

- 新运行时日志：`%LOCALAPPDATA%\InternalBeyond\logs`；
- 旧安装目录 logs：保留到 takeover snapshot/retirement policy 明确；
- installer transient diagnostics：继续由 installer contract 管理。

## K. User Data Boundary

静态/source 与 metadata audit 结果：

| Class | Policy | P32-W.4A result |
|---|---|---|
| Active state | preserve / leave untouched | `%LOCALAPPDATA%\InternalBeyond\active-message-service.json`，未读内容/未写入 |
| Vault | preserve / leave untouched | metadata only；未读 secret、未写入 |
| Bridge state | preserve / leave untouched | `%LOCALAPPDATA%\InternalBeyond\bridge` |
| Home Node DB | preserve / leave untouched | `%LOCALAPPDATA%\InternalBeyond\home-node` |
| boot-state/update state | preserve / future runtime-owned | `%LOCALAPPDATA%\InternalBeyond` |
| WebView profile | leave untouched / separate authority | `%LOCALAPPDATA%\com.internalbeyond.desktop\EBWebView` |
| old install-root logs | preserve pending takeover snapshot | `[local path redacted]` |

P32-W.4A 没有执行真实 migration；主数据与 install payload 的边界仍以 preserve/leave untouched 为准。

## L. Cross-Installer Takeover Model

只设计，不执行真实 takeover：

```text
DISCOVER
  → SNAPSHOT
  → VALIDATE_DATA_BOUNDARY
  → INSTALL_CANONICAL
  → VERIFY_CANONICAL
  → SWITCH_SHORTCUT_AUTHORITY
  → VERIFY_LIVE_ROOT
  → RETIRE_ACCEPTANCE_IDENTITY_ELIGIBILITY
  → COMPLETE
```

每个 state 的安全规则：

- `DISCOVER`：确认当前 Tauri/Inno identities、shortcuts、processes、roots。
- `SNAPSHOT`：只记录 metadata/hash，不读 credential plaintext。
- `VALIDATE_DATA_BOUNDARY`：若 payload 覆盖 user data 或 install-root logs preservation 未闭合，STOP。
- `INSTALL_CANONICAL`：只调用 canonical Inno installer；不先卸载 Tauri。
- `VERIFY_CANONICAL`：manifest、Host、runtime identity、runner/services root 全部 PASS。
- `SWITCH_SHORTCUT_AUTHORITY`：只允许 Inno-owned canonical installer 修改其 own shortcut；失败则 takeover incomplete。
- `VERIFY_LIVE_ROOT`：确认当前 Host/runner/Active 不再来自 `_up_`。
- `RETIRE_ACCEPTANCE_IDENTITY_ELIGIBILITY`：只有 canonical runtime 已启动验证成功后，stale Tauri uninstall 才变为 cleanup-eligible；本阶段不执行 cleanup。
- `COMPLETE`：canonical install/shortcut/live root/data invariance 全部 PASS。

Rollback rule：任何 canonical install/verification/shortcut/live-root failure 都保留当前 Tauri installation，不卸载、不删除、不切换真实 shortcuts。

## M. Shortcut Authority

未来 canonical production shortcut 必须由 Inno 创建并指向：

```text
canonical-root\internalbeyond-host.exe
```

不得指向 `_up_`、workspace、VBS 或 Tauri acceptance root。VBS 保留 fallback role，不删除。

P32-W.4A 未修改当前 Desktop/Start Menu shortcut；旧 Tauri shortcut 仍保持原状，等待 P32-W.4B takeover。

## N. Uninstall Ownership

目标语义：

- canonical Inno uninstall 只移除其 own payload/identity/shortcuts，保留 `%LOCALAPPDATA%\InternalBeyond`；
- Tauri acceptance uninstall 只允许在 acceptance-isolated test root 中验证，不得误删 canonical root、user data、WebView profile、Vault 或 Active state；
- 当前两个真实 identity 不执行任何卸载。

## O. Canonical Build

本阶段没有运行 `scripts/build-installer.ps1`，没有生成新 installer。原因是用户要求在 runtime mode、positive identity、log ownership 和 takeover design 一致前停止 installer build。

唯一允许的后续 build authority仍是：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-installer.ps1
```

## P. Artifact Verification

未执行 artifact/installer verification。下一阶段必须验证：

- Inno EXE、SHA256SUMS、stable manifest 一致；
- final `ib-payload-manifest.json` 包含 Host、R10.1 files、VBS、ib-stop、bundled Node；
- final installed root 不依赖 `_up_`；
- R10.1 writer 仅做 presence/structural/runtime loading verification，不执行 credential transaction。

## Q. Fresh Install E2E

未执行。必须创建新的 isolated root，不得使用 `[local path redacted]` 或 `[local path redacted]`。必须隔离 ports、data root、boot-state、registry/shortcut identity where possible。

## R. Running Upgrade E2E

未执行。必须从 isolated old canonical install 构造 upgrade，验证 root-scoped stop、payload manifest diff、Host/runner/services replacement、user data invariance 和 R10.1 presence。

## S. Acceptance Isolation E2E

未执行。未来 acceptance E2E 必须显式传递 `IB_RUNTIME_MODE=acceptance`，投影 `tauri-resource`，且不得污染当前 Tauri install/registry/shortcuts。

## T. Cross-Installer Takeover Simulation

未执行。必须在 isolated harness 模拟 Tauri acceptance identity + Inno canonical takeover，验证 canonical install 成功后才允许 acceptance cleanup eligibility；真实 machine 不执行。

## U. Failure Injection

source-level contract 已覆盖/设计以下 fail-closed cases：

- production manifest missing/malformed；
- Host missing；
- required file missing；
- product/version mismatch；
- release `IB_PROJECT_ROOT` redirect；
- acceptance root missing；
- production root 旁存在 `_up_` 时不 fallback。

实际 installer failure injection、shortcut failure、user-data hash failure、takeover rollback 未执行。

## V. R10.1 Installed Payload Verification

当前真实 installed payload 仍未加载 R10.1；本阶段没有修改它。workspace/source contract test 已确认：

- `active/persistence.js` 被 canonical manifest 覆盖；
- `services/active-message-service.js` 被 canonical manifest 覆盖；
- final generated manifest 需要在 build 后包含 Host + R10.1 source payload。

只允许下一阶段 isolated install 验证 R10.1 presence/structural loading；禁止调用真实 credential transaction。

## W. Packaging Regression

已完成 source/static checks：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：PASS；
- `cargo check --manifest-path src-tauri/Cargo.toml`：PASS；
- P32-W.4A runtime authority contract test：PASS；
- boot-state regression：37/37 PASS；
- launcher regression：16/16 PASS；
- `tests/test_installer.js`：51 PASS，1 个已知 `VERSION` trailing-newline baseline failure；
- 没有运行 installer smoke/build/upgrade/uninstall。

既有 7 个 frontend BOM failures 未触碰。

## X. Real Machine Invariance

意图性 P32-W.4A 操作没有修改：

- `[local path redacted]`；
- current `_up_`；
- current live PID/process tree；
- registry identities；
- current shortcuts；
- Vault/Active/Bridge/Home Node data；
- provider/credential data。

注意：在 launcher log ownership 修复后的第一次回归测试前，旧 test harness 曾继承真实 `LOCALAPPDATA`，产生了 launcher diagnostic log side effect；该 harness 随后已改为临时 LOCALAPPDATA，后续 boot-state/launcher 回归均写入 temp root。没有 credential、Vault、Active state 或业务数据写入。故本阶段严格 machine invariance 标记为 **DEGRADED**，不可宣称全绿。

## Y. P32-W.4B Runbook

P32-W.4B 只在明确批准后执行真实 takeover，runbook 顺序固定为：

```text
PRECHECK
  → SNAPSHOT
  → CANONICAL INSTALL
  → LIVE VERIFY
  → SHORTCUT VERIFY
  → DATA VERIFY
  → ACCEPTANCE RETIREMENT ELIGIBILITY
  → OPTIONAL CLEANUP
  → FINAL VERIFY
```

关键 stop conditions：canonical install/manifest/Host/live root 任一失败、data boundary 不一致、shortcut switch 失败、rollback 不成立、credential/Vault metadata 变化、provider call > 0，立即停止且保留当前 Tauri install。

Acceptance install 只有在 canonical runtime 已成功安装、启动、验证、shortcut authority 已确认、user data invariance 已确认后，才可进入 cleanup eligibility；本阶段不卸载。

## Z. Closure Gate

当前 gate：

| Gate | Result |
|---|---|
| explicit runtime modes implemented | PASS (workspace) |
| production positive payload identity implemented | PASS (workspace) |
| production silent `_up_` fallback removed | PASS (workspace source) |
| acceptance `_up_` explicit and preserved | PASS (workspace contract; E2E pending) |
| development workspace explicit and preserved | PASS (workspace contract) |
| canonical manifest includes Host | PASS by build source ordering; final artifact pending |
| canonical manifest includes R10.1 source payload | PASS by source whitelist; final artifact pending |
| install-root log ownership closed | PASS for future launcher logs; old logs preserved pending takeover |
| user-data boundary proven | DEGRADED: primary data separated; install-root logs still need takeover policy |
| takeover state machine defined | PASS (design only) |
| cross-installer rollback defined | PASS (design only) |
| canonical build | NOT EXECUTED |
| fresh install E2E | NOT EXECUTED |
| running upgrade E2E | NOT EXECUTED |
| isolated uninstall | NOT EXECUTED |
| acceptance isolation | NOT EXECUTED |
| takeover simulation | NOT EXECUTED |
| R10.1 isolated installed payload | NOT EXECUTED |
| real installation/process/registry/shortcut unchanged | DEGRADED due early test log side effect; no payload/registry/process/data mutation |
| credential writes | 0 |
| credential secret reads | 0 by intentional P32-W.4A operations |
| provider calls | 0 |
| new regressions | No new failures observed; one pre-existing VERSION baseline failure remains |

### Final summary

```text
Runtime modes: production / acceptance / development implemented in workspace
Production positive identity: ib-payload-manifest + VERSION + Host + required payload membership
Production _up_ fallback: removed; production fails closed with RUNTIME_PAYLOAD_INVALID
Acceptance _up_ support: explicit IB_RUNTIME_MODE=acceptance only
Development workspace support: debug mode / IB_PROJECT_ROOT only in development
Canonical manifest Host: build ordering PASS; final artifact not built
R10.1 in canonical payload: source whitelist PASS; installed artifact not verified
Install-root logs ownership: future launcher logs moved to %LOCALAPPDATA%\InternalBeyond\logs
Primary user-data boundary: preserve/leave untouched; primary data outside install roots
Canonical build: not executed
Fresh install: not executed
Running upgrade: not executed
Isolated uninstall: not executed
Acceptance isolation: not executed
Takeover simulation: not executed
Real [local path redacted] changes: no intentional changes
Real process changes: none
Real registry changes: none
Real shortcut changes: none
Real user-data changes: no credential/business-state writes; early test launcher-log side effect recorded as DEGRADED
Credential writes: 0
Credential secret reads: 0
Provider calls: 0
New regressions: none attributable; existing VERSION newline baseline remains
P32-W.4B readiness: runbook/design ready, real takeover not authorized
P32-W.4A status: DEGRADED / PREPARED FOR NEXT BUILD GATE
```

P32-W.4A 到此停止。不要执行 build installer、任何 installer、真实 takeover、shortcut/registry cleanup、R10.2 Retry、Active privileged auth、R10 Retry #2、R11、Developer Mode、Jev、Android、Backup v2 或 Storage Convergence。不 commit，不 push。

# P32-W.4A-BG Canonical Build & Isolated Acceptance Gate

日期：2026-09-22（Asia/Shanghai）  
范围：canonical artifact build + pre-spawn isolation gate；未运行 installer

P32-W.4A-BG 当前状态：**BLOCKED before isolated installer spawn**。

## A. Scope

本轮完成：

- test isolation guard；
- real-machine read-only before/after snapshot；
- canonical Inno build；
- artifact/checksum/stable-manifest verification；
- compile-log payload presence verification；
- installer E2E pre-spawn safety decision。

本轮没有运行任何 installer，没有写 test registry/shortcut，没有启动 isolated IB，没有修改真实安装、真实 registry、真实 shortcut 或真实 user data。

## B. Isolation Precheck

### B1. Guard implementation

新增 `tests/p32-w4a-isolation-guard.js`，并接入 `tests/test_installer_smoke.js`。在任何 installer/Host/decoy spawn 前检查：

- `LOCALAPPDATA`、`APPDATA`、`USERPROFILE`、`TEMP`、`TMP`；
- Active、Bridge、Home Node、boot-state、logs、WebView profile data roots；
- install root 与真实 Tauri/Inno roots；
- test shortcut namespace；
- ports 与 product defaults；
- test-only AppId/display name 与 production/Tauri identities 的分离；
- Windows `WScript.Shell.SpecialFolders(AppData/Desktop/Programs)` 的实际解析结果。

Path/identity unit guard：PASS。

### B2. Actual Windows shell isolation result

实际 Windows shell folders 仍解析到：

```text
AppData  = [local path redacted]
Desktop  = [local path redacted]
Programs = [local path redacted] Menu\Programs
```

它们没有解析到 test-owned temporary roots。因此真正的 installer shortcut namespace 不能被当前 harness 证明隔离。guard 的预期行为是 **FAIL BEFORE SPAWN**；没有通过环境变量伪造 PASS，也没有继续运行 installer。

这满足 P32-W.4A-BG stop condition：若 installer 无法安全隔离 registry/shortcut，不运行 fresh install/upgrade/uninstall。

## C. Real Machine Before Snapshot

已只读记录：

- current Host/runner/Active/Bridge/Home Node/static PIDs、PPID、command line；
- Tauri 与 Inno uninstall identities；
- Desktop/Start Menu shortcut targets；
- boot-state projection metadata；
- credential-vault/Active state metadata（size/mtime only）；
- install roots、data roots 与 WebView profile root metadata。

没有读取 credential plaintext、Vault plaintext、Active state content 或 provider response。

## D. Canonical Build

已执行唯一 canonical command：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-installer.ps1
```

结果：**PASS**。

Build stages：

- preflight：PASS；root VERSION=`1.0.6`；
- bundled Node gate：PASS；Node `24.18.0`；
- whitelist staging：PASS；354 source files；
- stable Host build/stage：PASS；Host version `1.0.6`；
- generated payload manifest：356 files；
- release audit：0 errors，8 non-blocking content warnings；
- ISCC compile：PASS；
- update manifest：PASS；
- install audit：按默认 contract 未执行。

Known VERSION trailing-newline static baseline was not modified。

## E. Artifact Verification

生成 artifact：

```text
dist/InternalBeyond-Setup-1.0.6.exe
bytes = 54,514,701
sha256 = afa64160c4ad5dac2fd2d9141eecd4d129747cd931f34967b8d8a7fca6fd1a15
```

`dist/update-stable.json` 对账：

- version=`1.0.6`；
- installer asset=`InternalBeyond-Setup-1.0.6.exe`；
- size=`54,514,701`；
- sha256 与 EXE 实测一致；
- PE ProductVersion=`1.0.6` 与 root VERSION 一致。

`dist/SHA256SUMS.txt` 使用同一 EXE hash。`dist/build-compile.log` 的 Inno compression evidence 确认：

- `ib-payload-manifest.json` 被压入；
- `internalbeyond-host.exe` 被压入；
- `active/persistence.js` 被压入；
- `services/active-message-service.js` 被压入。

因此 Host 是最终 payload manifest/build authority 的一部分，不是 installer 外部特判。

## F. R10.1 Artifact Presence

PASS（artifact/build evidence）：

- source manifest closure 包含 `active/persistence.js`；
- source manifest closure 包含 `services/active-message-service.js`；
- Inno compile log 对两者均出现 `Compressing`；
- workspace R10.1 writer/seam structural tests 已通过。

没有执行真实 credential transaction，也没有读取真实 Active state。

## G. Production `_up_` Independence

Source-level fail-closed contract：PASS。

Production installed runtime independence E2E：**NOT EXECUTED**，因为 installer spawn 被 Windows shell isolation gate 阻断。

当前尚未证明：

- fresh canonical install 在无 `_up_` root 时实际启动；
- broken canonical root + fake `_up_` 时实际返回 `RUNTIME_PAYLOAD_INVALID`。

这两项必须在能安全隔离 installer shortcut/registry 的环境中执行。

## H. Fresh Install

NOT EXECUTED。

原因不是 artifact failure，而是 test-owned Windows shell shortcut namespace 无法在当前 user session 中证明隔离。按照 hard boundary，不启动 Inno installer。

## I. Fresh Runtime Smoke

NOT EXECUTED。没有产生 isolated Host/runner/Active PID，也没有 provider call。

## J. Production Fail-Closed Matrix

Source contract 已实现并通过静态/runtime authority contract test；实际 installed process matrix尚未运行：

| Case | Source contract | Isolated runtime |
|---|---|---|
| manifest missing/malformed | fail closed | not executed |
| schema/version/product mismatch | fail closed | not executed |
| Host missing/not in manifest | fail closed | not executed |
| bundled Node/launcher/runner missing | fail closed | not executed |
| Active/Bridge/Home Node/Active persistence missing | fail closed | not executed |
| fake `_up_` beside invalid production root | no production fallback | not executed |
| workspace redirect in release | rejected | not executed |

## K. Acceptance Isolation

NOT EXECUTED。Acceptance mode remains explicit through `IB_RUNTIME_MODE=acceptance`; no Tauri acceptance installer was run and no `_up_` tree was modified.

## L. Development Regression

Source contract and workspace runtime authority test：PASS。

- debug default = development；
- workspace root supported；
- `IB_PROJECT_ROOT` release redirect rejected；
- `.tauri-frontend`/devUrl contract unchanged。

## M. Running Upgrade

NOT EXECUTED。真实旧 Inno root `[local path redacted]` was not used as a test sandbox。

## N. Isolated Uninstall

NOT EXECUTED。没有创建 test registry identity、shortcut 或 install root。

## O. Cross-Installer Takeover Simulation

NOT EXECUTED。Takeover simulation remains defined in the previous P32-W.4A section; it requires a safe registry/shortcut isolation mechanism first。

## P. Takeover Failure Injection

NOT EXECUTED。No canonical/acceptance takeover state was created。

## Q. Shortcut Authority

Static canonical contract：PASS — Inno shortcut target is canonical-root `internalbeyond-host.exe`。

Runtime shortcut simulation：BLOCKED before spawn because Windows shell special folders resolve to the real user profile。

## R. Registry Identity

Static test-only AppId separation exists in the Inno source, but actual registry write was not attempted. Real Tauri/Inno identities remain unchanged。

## S. Install-Root Logs

Source contract：PASS — future launcher logs use test/per-user `LOCALAPPDATA\InternalBeyond\logs`，not install root。

Old legacy install-root logs were not migrated or deleted。Installer transient diagnostics remain an installer-owned contract。

## T. User-Data Fixture Invariance

NOT EXECUTED because no installer/runtime E2E was spawned。

## U. Real Machine After Snapshot

After-snapshot comparison：

- process identity/command lines：unchanged；
- registry identities：unchanged；
- real Desktop/Start Menu shortcuts：unchanged；
- install roots：unchanged；
- credential-vault metadata：unchanged；
- boot-state metadata：unchanged；
- Active state size unchanged, but mtime advanced during the live service’s normal operation；this is not attributable to test spawn because no test runtime was started；
- real `%LOCALAPPDATA%\InternalBeyond` directory mtime advanced with the live Active state update。

No installer/test process was started against the real machine。

## V. Cleanup

No installer cleanup was needed. Only workspace build artifacts were produced by the canonical build. No real registry/shortcut/install/data cleanup was attempted。

The isolation harness now refuses before spawn when Windows shell folders are not test-owned。

## W. Full Regression

Executed before the installer gate:

- P32-W.4A runtime authority contract: PASS；
- P32-W.4A path/identity isolation guard: PASS；
- Windows shell isolation probe: expected BLOCKED；
- cargo fmt check: PASS；
- cargo check: PASS；
- boot-state: 37/37 PASS；
- launcher: 16/16 PASS；
- installer static contract: 51 PASS + 1 known VERSION newline baseline failure。

Not executed due stop condition：fresh install、runtime smoke、fail-closed installed matrix、acceptance isolation、upgrade、uninstall、takeover simulation、failure injection、R10.1 installed runtime test。

## X. Closure Gate

| Gate | Result |
|---|---|
| canonical build | PASS |
| artifact manifest/checksum/stable manifest | PASS |
| Host in manifest | PASS by build/compile evidence |
| R10.1 in artifact | PASS by source/compile evidence |
| production `_up_` independence | NOT EXECUTED |
| production fail-closed installed test | NOT EXECUTED |
| fresh install/runtime smoke | BLOCKED before spawn |
| acceptance isolation | BLOCKED before spawn |
| development regression | PASS |
| running upgrade | NOT EXECUTED |
| isolated uninstall | NOT EXECUTED |
| takeover simulation/failure injection | NOT EXECUTED |
| shortcut/registry simulation | BLOCKED before spawn |
| install-root logs regression | source PASS; E2E not executed |
| synthetic user-data invariance | NOT EXECUTED |
| real install/registry/shortcut changes | 0 |
| real process changes attributable to test | 0 |
| credential writes | 0 |
| credential secret reads | 0 |
| provider calls | 0 |
| new regressions | none attributable; known VERSION baseline remains |

## Y. P32-W.4B Readiness

P32-W.4B readiness：**NOT READY**。

Canonical artifact is now available and structurally correct, but isolated installer acceptance is not proven because this Windows user session cannot provide test-owned shell shortcut folders/registry isolation. Do not infer takeover safety from the successful build alone.

### Final summary

```text
Canonical build: PASS
Installer artifact: dist/InternalBeyond-Setup-1.0.6.exe (54,514,701 bytes)
Payload manifest: PASS, 356 files; Host + manifest included
Host in manifest: PASS
R10.1 in artifact: PASS by compile/source evidence
R10.1 in isolated installed payload: NOT EXECUTED
Production _up_ dependency: source fail-closed PASS; runtime E2E not executed
Production fail-closed: source PASS; installed matrix not executed
Fresh install: BLOCKED before installer spawn
Fresh runtime smoke: NOT EXECUTED
Acceptance isolation: BLOCKED before installer spawn
Development regression: PASS
Running upgrade: NOT EXECUTED
Isolated uninstall: NOT EXECUTED
Takeover simulation: NOT EXECUTED
Failure injection: NOT EXECUTED
Shortcut authority: source PASS; Windows shell isolation blocked
Registry identity simulation: not executed
Install-root logs: source PASS; E2E not executed
Synthetic user-data invariance: not executed
Real install changes: 0
Real process changes: 0 attributable to test
Real registry changes: 0
Real shortcut changes: 0
Real LOCALAPPDATA changes: no intentional test writes; live Active mtime advanced normally
Credential writes: 0
Credential secret reads: 0
Provider calls: 0
New regressions: none attributable; known VERSION newline baseline remains
P32-W.4B readiness: NOT READY
P32-W.4A-BG status: BLOCKED before isolated installer spawn
```

P32-W.4A-BG 到此停止。不要继续真实 takeover、真实 installer/uninstaller、shortcut/registry cleanup、R10.2、R11、Active privileged auth、R10 Retry #2、Developer Mode、Jev、Android、Backup v2 或 Storage Convergence。不 commit，不 push。

# P32-W.4A-BG2 Disposable Windows Installer Acceptance

日期：2026-09-22（Asia/Shanghai）  
阶段：Disposable Environment Discovery only

## A. Scope

BG2 本轮严格只执行 disposable Windows environment discovery。没有启动 installer、没有启动 VM/Sandbox、没有修改 Windows optional feature、没有 reboot、没有写 registry/shortcut/user data，也没有停止当前 live IB。

## B. Host Safety Boundary

Host machine 保持 read-only：

- `[local path redacted]` 未修改；
- 当前 `_up_` 未修改；
- `[local path redacted]` 未修改；
- 当前 live process/registry/shortcut 未修改；
- credential writes：0；credential secret reads：0；provider calls：0。

Canonical artifact 已存在于 workspace `dist/`，本轮没有重新 build 或写 installer。

## C. Disposable Environment Discovery

只读检查结果：

| Check | Result |
|---|---|
| Windows edition | Windows 11 Pro for Workstations x64 |
| Windows Sandbox feature `Containers-DisposableClientVM` | Disabled (`State=0`), restart required |
| `WindowsSandbox.exe` | Missing |
| Hyper-V feature | Disabled (`State=0`), restart required |
| `vmconnect.exe` / existing Hyper-V VM tooling | Missing |
| VirtualBox/QEMU tooling | Missing |
| `HypervisorPresent` | true, but not sufficient for a disposable Windows environment |
| `VirtualizationFirmwareEnabled` | false |
| SLAT | false |
| Existing project disposable Windows harness | Not found |
| WSL | present, but not a disposable Windows GUI/registry/shortcut environment |

Windows Sandbox is therefore not available or enabled, and cannot be made available within this task without enabling an optional Windows feature and rebooting. Hyper-V/VM fallback is also unavailable. No enablement command, DISM command, hypervisor installation or reboot was attempted.

## D. Sandbox/VM Identity

Not applicable because no disposable Windows environment exists on this host.

The required BG2 environment would need independent HKCU/registry, Desktop/Start Menu, AppData/LocalAppData/TEMP, process tree, WebView profile and installer/uninstall identities. The current host session cannot provide those guarantees; the existing `WScript.Shell.SpecialFolders` guard correctly rejects it.

## E. Artifact Transfer Integrity

Not executed. If a disposable Windows environment becomes available, the already-built `dist/InternalBeyond-Setup-1.0.6.exe` must be transferred read-only/byte-exact, then size/SHA256/PE version recomputed inside that environment. The host artifact is not rebuilt inside the disposable environment.

## F. Synthetic Data Setup

Not executed. No real Vault, Active state, Bridge data, Home Node DB, WebView profile, registry or shortcut data was copied.

## G. Fresh Install through AB

Not executed. Installer semantics cannot be tested safely without disposable HKCU/Desktop/Start Menu/AppData.

## H. Result Classification

```text
Build Gate: PASS (from P32-W.4A-BG canonical build)
Disposable Installer Acceptance: BLOCKED_ENVIRONMENT
P32-W.4B: NOT_READY
```

## I. Stop Reason

BG2 stop condition is satisfied:

- Windows Sandbox unavailable/disabled;
- no disposable Windows VM/harness available;
- enabling features/rebooting is outside the authorized scope;
- returning to the real user session would write real installer registry/shortcut state and is explicitly forbidden.

P32-W.4A-BG2 stops here. Do not run installer, fresh install, upgrade, uninstall, acceptance takeover simulation or cleanup on the current host. Do not continue R10.2/R11 or any credential work. Do not commit or push.

# P32-W.4A-BG2.1 Disposable Environment Discovery

日期：2026-09-22（Asia/Shanghai）  
阶段：Phase 0 read-only discovery only

## A. Available Environment

Current host：Windows 11 Pro for Workstations x64, build `26200`。

### Windows Sandbox

- `WindowsSandbox.exe`：不存在。
- Optional feature `Containers-DisposableClientVM`：`State=0` / disabled。
- Feature reports `RestartRequired=1`。
- Windows Sandbox therefore cannot start in the current state。

### Hyper-V / VM fallback

- `Microsoft-Hyper-V-All`：`State=0` / disabled，restart required。
- `vmconnect.exe`：不存在。
- `vmms` service：not found。
- VirtualBox `VBoxManage.exe`：不存在。
- QEMU `qemu-system-x86_64.exe`：不存在。
- No existing project disposable Windows VM/harness was found in repository scripts/tests/docs。

### Virtualization capability

- `HypervisorPresent=true`。
- `VirtualizationFirmwareEnabled=false`。
- `SLAT=false`。

The presence of a hypervisor flag does not provide a disposable Windows user/registry/shortcut environment; Sandbox and Hyper-V are still unavailable.

### Other local tools

`wsl.exe` is present, but WSL is not a disposable Windows GUI/registry/Start Menu/Desktop environment and cannot satisfy BG2.

## B. Capability Result

```text
Windows Sandbox: unavailable / disabled
Disposable VM: unavailable
Existing project disposable harness: not found
Safe start without feature enablement/reboot: no
```

No `Enable-WindowsOptionalFeature`、DISM、hypervisor installation or reboot was attempted. The current user session remains disqualified because Windows shell `AppData/Desktop/Programs` still resolve to the real profile.

## C. Artifact and Report Transfer Design

Not executed because no disposable environment exists. If a Sandbox/VM becomes available, the already-built artifact will be transferred as a read-only input:

```text
dist/InternalBeyond-Setup-1.0.6.exe
```

Host-side filename/size/SHA256 will be compared with the independently recomputed values inside the disposable environment. Test output will return only text/JSON reports, hashes, process/root metadata, bounded registry identity data and shortcut target metadata; no real user profile, Vault, credential, or WebView profile will be transferred.

## D. Environment Gate

```text
Build Gate: PASS
Disposable Environment: BLOCKED_ENVIRONMENT
P32-W.4B: NOT_READY
```

BG2.1 stops here. Do not enter installer, fresh install, upgrade, uninstall, takeover, cleanup, R10.2 or credential work until a disposable Windows environment is available without changing the host configuration or rebooting it.

# P32-W.4A-C Local Cleanup Preparation

日期：2026-09-22（Asia/Shanghai）  
状态：**PREPARED / READ-ONLY**

## A. Scope

本阶段只生成真实机器 cleanup inventory、user-data boundary、future cleanup state machine、reinstall preconditions 和 rollback plan。没有删除、卸载、安装、升级、停止/重启 live IB、修改 registry、修改 shortcut 或写 user data。

## B. Installation Inventory

| Root | Identity | Version | Manifest | Host | Runtime classification | Owner |
|---|---|---|---|---|---|---|
| `[local path redacted]` | Tauri uninstall key `...\\Uninstall\\InternalBeyond` | 1.0.6 | absent | present | active acceptance install; live `_up_` runtime | Tauri NSIS |
| `[local path redacted]` | Inno GUID `_is1` | 1.0.6 | present, count 308 | absent | stale/incomplete old canonical payload | Existing Inno |

Current Tauri root has `_up_`, no VBS and no `tools/ib-stop.js`; current Inno root has VBS/`ib-stop.js`, but its old manifest does not declare Host.

## C. Registry Inventory

Read-only identities:

- `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\InternalBeyond` → Tauri root `[local path redacted]`, `uninstall.exe`。
- `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\{78B427F6-A48F-4443-86D5-2F50DC899D07}_is1` → Inno root `[local path redacted]`, `unins000.exe`。
- `HKCU\Software\InternalBeyond\InternalBeyond` → Tauri previous-install metadata key。
- HKLM matching InternalBeyond entries：absent。

Registry ambiguity：**YES**。Two same-product identities coexist; no cleanup is safe before canonical install/rollback ownership is proven.

## D. Shortcut Inventory

Read-only targets:

- Desktop `InternalBeyond.lnk` → `[local path redacted]`。
- Start Menu `InternalBeyond.lnk` → `[local path redacted]`。
- Start Menu `卸载 InternalBeyond.lnk` → `[local path redacted]`。
- Desktop `InternalBeyond.html.lnk` → workspace `E:\InternalBeyond-main\InternalBeyond.html`。

Shortcut ambiguity：**YES**。Normal launch uses Tauri Host, while uninstall shortcut uses Inno root; a workspace Browser shortcut also exists. No shortcut changes were made.

## E. Runtime Process Inventory

当前 live process roots remain:

- Host PID 17168 → `[local path redacted]`。
- Runner PID 23928 → `[local path redacted]`。
- Active PID 13376 → `[local path redacted]`。
- Bridge PID 28732 → `_up_\services\ib-bridge-service.js`。
- Home Node PID 21764 → `_up_\services\home-node-service.js`。
- Static PID 21752 → `_up_\services\internal-beyond-server.js`。

没有停止、重启或 kill 任何 process。

## F. User Data Boundary

Primary data root remains `%LOCALAPPDATA%\InternalBeyond`，包含 metadata entries for Active、Vault、Bridge、Home Node、boot-state、logs、updates。Tauri WebView profile remains `%LOCALAPPDATA%\com.internalbeyond.desktop\EBWebView`。

只记录了 size/mtime metadata；没有读取 credential plaintext、Vault content、Active state content 或 WebView content。

策略：

- `%LOCALAPPDATA%\InternalBeyond`：preserve / leave untouched；
- WebView profile：preserve / separate authority；
- old Inno install-root logs：preserve pending future snapshot；不迁移、不删除；
- install payload：future canonical installer ownership only。

## G. Cleanup State Machine

未来真实 cleanup/takeover 的设计顺序：

```text
SNAPSHOT
  → VERIFY USER DATA OUTSIDE INSTALL ROOT
  → STOP CURRENT OWNED RUNTIME
  → REMOVE OLD INSTALL PAYLOAD
  → REMOVE STALE SHORTCUTS
  → REMOVE STALE INSTALL IDENTITY
  → INSTALL CANONICAL INNO
  → VERIFY RUNTIME
  → VERIFY USER DATA
  → COMPLETE
```

当前阶段只保存设计，不执行任何 state transition。实际顺序必须由 P32-W.4B 明确批准的 takeover runbook 约束；canonical install/verify 必须先成功，acceptance cleanup 才能 eligibility。

## H. Canonical Reinstall Preconditions

执行前必须同时满足：

- data boundary snapshot exists；
- old install inventory/registry/shortcut snapshot exists；
- canonical Inno EXE hash/version/manifest verified；
- root-scoped stop authority and rollback entry defined；
- user data is outside the payload being replaced；
- shortcut ownership is unambiguous；
- failure leaves current working entry usable；
- no credential plaintext read、provider call 或 migration。

目前未满足“canonical install can be safely executed on this real session”，因为 disposable Windows acceptance 仍 `BLOCKED_ENVIRONMENT`，且两套真实 identity/shortcut 仍冲突。

## I. Rollback Plan

若未来 canonical install/verification 失败：

1. 不卸载当前 Tauri acceptance install；
2. 不删除旧 Inno root；
3. 不修改真实 shortcut/registry，除非该步骤已由 canonical installer 明确拥有且可反向恢复；
4. 保留 `%LOCALAPPDATA%\InternalBeyond` 和 WebView profile；
5. 恢复之前的 shortcut/entry only from exact ownership snapshot；
6. 标记 takeover incomplete，停止后续 cleanup。

如果 rollback 无法保证 working entry，真实 takeover 必须 BLOCKED。

## J. P32-W.4B Readiness

```text
Installation inventory: complete (read-only)
User data boundary: primary data separated; install-root logs require preservation policy
Registry ambiguity: present
Shortcut ambiguity: present
Safe cleanup plan: designed, not executable yet
Rollback readiness: designed, not exercised
P32-W.4B readiness: NOT_READY
P32-W.4A-C status: PREPARED
```

等待明确批准后才能执行真实 cleanup/takeover；本阶段没有任何 destructive action。不 commit，不 push。

# P32-W.4B Disposable Acceptance Environment Design

日期：2026-09-22（Asia/Shanghai）  
阶段：provider discovery/planning only

## Available environments

| Candidate | Current result | Reason |
|---|---|---|
| A. Windows Sandbox | BLOCKED_ENVIRONMENT | feature disabled, `WindowsSandbox.exe` missing, restart required |
| B. Hyper-V/disposable VM | BLOCKED_ENVIRONMENT | Hyper-V disabled, `vmconnect.exe` missing, virtualization prerequisites unavailable |
| C. Existing CI/disposable Windows runner | BLOCKED_ENVIRONMENT | no project Windows CI/disposable VM harness found; Docker/VM tooling absent |

WSL exists but is not a disposable Windows HKCU/Desktop/Start Menu/AppData environment and is not accepted as a BG2 provider.

No Windows feature was enabled, no hypervisor was installed, and no reboot occurred.

## Isolation strategy

New workspace-only provider module:

```text
tests/p32-w4b-disposable-acceptance-provider.js
```

It defines a provider discovery/planning boundary with independent slots for registry/HKCU identity, Desktop and Start Menu shortcut namespace, APPDATA/LOCALAPPDATA/TEMP/TMP, install root and loopback ports, synthetic data fixtures, and read-only artifact transfer.

The provider does not enable features, create a VM, invoke an installer, change registry, change shortcuts, or fall back to the real user session.

## Installer safety

`prepare()` accepts the already-built Inno EXE as a read-only input and records filename/path, size and SHA256; the disposable environment must independently revalidate filename, size, SHA256 and PE ProductVersion.

Current provider result:

```text
providerStatus = BLOCKED_ENVIRONMENT
selectedProvider = none
artifact = InternalBeyond-Setup-1.0.6.exe / 54,514,701 bytes
execution = not-started
```

`execute()` is intentionally non-spawning until an explicitly injected disposable provider adapter exists. The provider test passed planning/refusal behavior without starting an installer.

## Rollback strategy

Provider-owned execution must be disposable by construction: destroy only the provider-owned VM/Sandbox/profile/install root/registry fixture after collecting bounded reports. There is no host-machine rollback operation because the provider must never write host registry, shortcuts or user data.

If a provider cannot prove separate HKCU/Desktop/Start Menu/AppData, it must return `BLOCKED_ENVIRONMENT` before spawn. The current Windows shell-folder guard remains unchanged and continues to reject the real user session.

## P32-W.4B readiness

```text
Disposable provider design: PREPARED
Provider implementation: discovery/planning only
Available disposable Windows environment: none
Installer execution: not started
P32-W.4B readiness: NOT_READY
P32-W.4B status: BLOCKED_ENVIRONMENT
```

Do not enter installer, upgrade, uninstall, takeover, cleanup, R10.2 or credential work until a Windows Sandbox or disposable Windows VM/CI runner is available without modifying the host system configuration. Do not commit or push.

# P32-W.5-R Reference

Post-uninstall recovery audit found `%LOCALAPPDATA%\\InternalBeyond` absent while the Tauri WebView profile and an existing auto-backup export remain. P32-W.5 canonical reinstall is **BLOCKED_DATA_RECOVERY**; details are recorded in `docs/P32-W5-INSTALLER-AUTHORITY-UX-UNIFICATION.md`. P32-W.4 historical authority-drift evidence remains unchanged.
