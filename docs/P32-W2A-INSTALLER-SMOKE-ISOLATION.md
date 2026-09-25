# P32-W.2A · Installer Smoke Isolation

审计日期：2026-09-21  
初始结论：**DEGRADED**。经 P32-W.2B runtime payload closure 与真实 runtime acceptance 补证，当前结论：**CLOSED / PASS**。

## A. Previous Stop Condition

P32-W.2 在 `docs/P32-W2-INSTALLER-AUTHORITY-CONVERGENCE.md:7-21` 触发 Stop Condition #4：现有 smoke 只隔离 `/DIR`、端口和 `LOCALAPPDATA`，但仍使用生产 Inno AppId `{78B427F6-A48F-4443-86D5-2F50DC899D07}` 对应的 HKCU uninstall key。该 key 当时登记真实生产安装 `[local path redacted]`。

本阶段只处理 smoke identity/registry/filesystem isolation；没有进入 P32-W.2 Resume、Android 或 P33。

## B. Harness Root Cause

原始链路是：

```text
installer/InternalBeyond.iss:47
  AppId={{78B427F6-A48F-4443-86D5-2F50DC899D07}
        ↓
scripts/build-installer.ps1:343
  只传 AppVersion/StagingDir/OutputDir
        ↓
tests/test_installer_smoke.js:80
  固定查询生产 {GUID}_is1
        ↓
/DIR 临时目录仍覆盖生产 uninstall identity
```

`/DIR` 只能隔离文件目录，不能隔离 Inno AppId、uninstall registry key、显示名或 shortcut identity。

另外，本轮审计发现两个实际 harness 缺口：旧 smoke 没有给 installer/uninstaller 传隔离 `LOCALAPPDATA`，且 lifecycle stop target 已包含 Home Node，却只分配了四个端口。两项均已在 test harness 内修复。

## C. Identity Model

| Identity | Value | Authority / evidence |
|---|---|---|
| Protected production AppId | `{78B427F6-A48F-4443-86D5-2F50DC899D07}` | `installer/InternalBeyond.iss:35,50-55`；smoke 以 hard boundary 校验 |
| Deterministic test-only AppId | `{A4D9E7B3-1F86-4C2A-9D57-6B3E1C8F0A24}` | `installer/InternalBeyond.iss:36-37`；显式 `InstallerTestMode` branch |
| Test display name | `InternalBeyond Installer Smoke Test` | `installer/InternalBeyond.iss:39,44-49` |
| Test publisher | `InternalBeyond (Test Only)` | `installer/InternalBeyond.iss:47` |
| Test default directory name | `InternalBeyond-Installer-Smoke-Test` | `installer/InternalBeyond.iss:41,48,85` |
| Test output | `InternalBeyond-Installer-Smoke-Test-Setup-1.0.6.exe` | `installer/InternalBeyond.iss:43,108` |

Production is the default. Test identity requires explicit `-TestMode` in the build script and `/DInstallerTestMode=1` in the Inno compiler args. Missing test mode never falls back to test identity.

## D. Changes

### `installer/InternalBeyond.iss`

- Added explicit production/test identity macros and compile-time branch: lines 35-56, 69-108.
- Test mode changes AppId, display/publisher name, default directory and output base name; production values remain the existing values.
- Historical test-only extraction of dirty-worktree `runtime/host-origin.js` was later converged by P32-W.2B into the canonical manifest/staged payload; the current Inno temp extraction uses the same production staged bytes at lines 151, 340-349.
- Added compile-time test-only data-root seam: lines 190-197, 358-362, 431, 448. Production still resolves to `{localappdata}\InternalBeyond`; test mode reads only `IB_INSTALLER_SMOKE_DATA_DIR`.

### `scripts/build-installer.ps1`

- Added explicit `-TestMode`: line 90 and parameter documentation at lines 60-68.
- Test output is bounded to `tmp\installer-smoke-build` and rejected if it overlaps production `dist`: lines 136-144, 270-278.
- `-InstallAudit` without `-TestMode` fails before staging/compile: lines 267-271.
- Test compile passes `/DInstallerTestMode=1`, uses a test-only output name, and records compile evidence: lines 432-455, 477-500.
- Test mode deliberately does not write `update-stable.json`: lines 496-507.
- Production mode keeps the existing `dist` output and update-manifest path; test summary explicitly says not to publish: lines 591-608.

### `tests/test_installer_smoke.js`

- Production/test identity parsing and compiled-artifact fail-closed proof: lines 60-70, 365-413.
- Production dist artifacts are rejected as smoke inputs; test sidecar, compiler log, display identity and hash are required before install.
- Registry snapshots cover production Inno, Tauri uninstall and Tauri manufacturer keys: lines 260-284, 339-357.
- Production installer/checksum/manifest/VERSION and production shortcut snapshots are compared before/after each destructive phase: lines 291-339, 886, 1074, 1110.
- Install root canonicalization/reparse guards and test-root ownership checks are enforced before install: lines 649-664.
- Isolation now covers five lifecycle ports, including `IB_HOME_NODE_PORT`: lines 114-120, 485, 510-529.
- Every child receives isolated `LOCALAPPDATA` and `IB_INSTALLER_SMOKE_DATA_DIR`: lines 475-486.
- Test-only registry/shortcut residue cleanup requires exact AppId, test display name, harness install root and exact shortcut target: lines 696-760, 1160-1169.
- Runtime launch failure stops the real smoke before upgrade/uninstall: lines 995-1001.

### `tests/test_installer.js`

Added static contract checks for the protected production AppId, independent test AppId, explicit test-mode compiler seam and test-only install path: lines 81-99, 347-350.

## E. Fail-Closed Guards

The smoke refuses to proceed when any of these is true:

- source production AppId is missing or differs from the protected GUID;
- test AppId is invalid or equals production;
- input EXE is inside production `dist` or has a production output name;
- test sidecar/compiler evidence is missing, hash-mismatched or not marked `testOnly`;
- test EXE lacks the compiled test display identity;
- test uninstall key already exists before the run;
- test root overlaps production/Tauri roots or contains a reparse/junction ambiguity;
- a production/Tauri registry snapshot or protected production artifact changes;
- test registry ownership does not resolve to the current harness root;
- launch acceptance fails before upgrade/uninstall.

No production uninstall key was deleted, restored, exported/imported or used as a disposable fixture.

## F. Registry Isolation

### Protected keys

The final read-only state remained:

| Key | Final state |
|---|---|
| Production Inno `...Uninstall\{78B427F6-A48F-4443-86D5-2F50DC899D07}_is1` | Present; `InstallLocation=[local path redacted]`; `DisplayName=InternalBeyond 1.0.6`; `DisplayVersion=1.0.6`; uninstaller remains production `unins000.exe` |
| Tauri `...Uninstall\InternalBeyond` | Present; `InstallLocation=[local path redacted]`; `UninstallString=[local path redacted]` |
| Tauri manufacturer `HKCU\Software\InternalBeyond\InternalBeyond` | Present; default remains `[local path redacted]` |
| Test Inno `...Uninstall\{A4D9E7B3-1F86-4C2A-9D57-6B3E1C8F0A24}_is1` | Absent after cleanup |

The install audit observed the test key present with `DisplayName=InternalBeyond Installer Smoke Test 1.0.6`, `Publisher=InternalBeyond (Test Only)`, isolated `InstallLocation`, and test-root `UninstallString`. The test uninstaller then removed it. The later real-launch attempt was stopped before upgrade/uninstall and its exact test-only key/shortcuts were removed by ownership-proven cleanup.

### Invariance

`production Inno before == after install == after uninstall` and `Tauri before == after install == after uninstall` held for the successful 21-check install audit. The final read-only query also confirmed all three protected keys remained unchanged after the degraded real-smoke attempt.

## G. Filesystem Isolation

- Successful install audit root: `[local path redacted]`.
- Successful audit data root: `[local path redacted]`.
- Degraded real-smoke root: `[local path redacted]`; it was removed after the launch gate failed.
- Production roots `[local path redacted]` and `[local path redacted]` were only read and remained registered.
- `[local path redacted]` was not used as the test data root. The harness freezes only the exact installer-side report paths (`upgrade-stop.json`, `upgrade-prune.json`, `runtime-invalid.txt`) rather than hashing the live user-data directory.
- Reparse/symlink/junction components are rejected before install; no ambiguity was observed.

## H. Shortcut Isolation

Test shortcuts use the visibly test-only name `InternalBeyond Installer Smoke Test` and a separate Start Menu folder. Production shortcuts remain:

- Start Menu: `...\Programs\InternalBeyond\InternalBeyond.lnk`
- Desktop: `...\Desktop\InternalBeyond.lnk`

The successful audit removed the test shortcuts through the test uninstaller. The degraded real-smoke cleanup removed only the exact test Start Menu launch/uninstall shortcuts and exact test Desktop shortcut after verifying their targets pointed into the current harness root. Production shortcuts still exist unchanged.

## I. Artifact Isolation

Production artifact baseline and final values were identical:

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `dist\InternalBeyond-Setup-1.0.6.exe` | 52,608,553 | `ffcf9e6a729d97383c5e36c51c80e2dadac3efedafe6f854d1a5c0d65c14eb5c` |
| `dist\SHA256SUMS.txt` | 406 | `0dfde9eff3e8545d9ef6a1509aed930de07da5a299988ada162d7517fb90e265` |
| `dist\update-stable.json` | 619 | `bdddf80ddd1d063e43d4a3a49f0797899853e15324f8acb207d0072ebe97c42c` |
| `VERSION` | 6 | `51c18dc8694861beb47a67894e61044864214435389f6d3a274704d9566ff96c` |

The final test-only build was `InternalBeyond-Installer-Smoke-Test-Setup-1.0.6.exe`, 52,871,338 bytes, SHA-256 `5a4bcb68af38ef144a1e757b079f1bddd7f85efd3cbc227c304539ff70680a76`. It was produced under `tmp\installer-smoke-build`, generated no `update-stable.json`, and was deleted after verification.

## J. Runtime Isolation

- Installer, uninstaller, launcher and stop helper receive the harness `LOCALAPPDATA` and `IB_INSTALLER_SMOKE_DATA_DIR`.
- Five isolated ports are allocated: Web, Restart, Bridge, Active and Home Node. No image-name process kill is used.
- Child cleanup uses exact tracked PIDs; root-scoped process discovery is used only for the current harness install root.
- Install/uninstall audit launch was intentionally suppressed and passed without browser opens.
- Historical real launch failure was caused by the runtime payload gap documented in P32-W.2B; the gap is now closed and the current real smoke evidence is recorded below.

## K. Test Results

| Gate | Result |
|---|---|
| Static identity/build guards | PASS; `test_installer.js` 49 passed, 1 pre-existing `VERSION` trailing-newline failure |
| Test-only ISCC build | PASS; explicit `InstallerTestMode=1`, test sidecar/hash/compiler evidence, production dist untouched |
| `--install-audit` | PASS; 21 passed, 0 failed; install, payload audit, test registry lifecycle and test uninstaller all passed |
| `--real-install-smoke` | DEGRADED; install/payload audit passed, runtime launch failed after 90s, upgrade/uninstall correctly not attempted |
| Exact residue cleanup | PASS; test registry, test shortcuts, test roots, test output and test setup logs removed |

The one static failure is existing repository state: `VERSION` contains `1.0.6\n` while the pre-existing contract expects no trailing newline. `VERSION` was not modified.

## L. Production Invariance

Confirmed final invariants:

```text
production Inno registry before = after install = after uninstall = final
Tauri uninstall/manufacturer registry before = after install = after uninstall = final
production installer/SHA256SUMS/update-stable/VERSION before = after = final
production Start Menu/Desktop shortcuts before = after = final
[local path redacted] untouched
[local path redacted] untouched
real %LOCALAPPDATA%\InternalBeyond installer-side report paths unchanged
```

No production registry restoration was needed because no production registry mutation occurred.

## M. Cleanup

Removed only harness-owned/test-only material:

- test install roots and isolated data roots under `%TEMP%`;
- exact test AppId uninstall key after ownership proof;
- exact test Start Menu launch/uninstall shortcuts and test Desktop shortcut after target proof;
- `tmp\installer-smoke-build` and its test-only EXE/checksum/identity/compiler log;
- setup logs created by this run.

No production artifact, production shortcut, production registry key, Tauri key, real install root or real user-data directory was deleted.

## N. Remaining

Only P32-W.2 Resume work remains:

1. Resolve the existing runtime distribution dependency (`runtime/host-origin.js`) in the canonical production payload/host distribution contract.
2. Re-run real launch, running upgrade and uninstaller acceptance only after that distribution issue is handled.
3. Continue the broader Tauri Host Distribution Contract / canonical installer convergence work only in P32-W.2 Resume.

Browser/Tauri storage split, DB migration, Tauri NSIS identity and Android remain out of scope.

## Closure Gate

P32-W.2A was initially **DEGRADED** because the real runtime launch gate failed on the missing runtime payload dependency. The original 21-check install/uninstall audit and all production invariance evidence remain valid.

## Closure Update · P32-W.2B

P32-W.2B added the two canonical Node payload dependencies found by the full closure audit:

- `runtime/host-origin.js`
- `services/project-knowledge.js`

The resolved manifest is now `ok=true`, `entries=41`, `files=350`, `totalBytes=129286427`, `missing=[]`, `denied=[]`. The smoke harness then passed:

- install audit: 22/22;
- real runtime install/launch/health/upgrade/uninstall: 43/43;
- installed `service-control.js` `require.resolve('./host-origin.js')` proof inside the isolated install root;
- production Inno/Tauri registry and production artifact invariance;
- exact test registry, shortcut, process and filesystem cleanup.

**Current closure state: P32-W.2A CLOSED / PASS.** P32-W.2 itself was not resumed in this turn; it may resume only under the next explicit instruction.
