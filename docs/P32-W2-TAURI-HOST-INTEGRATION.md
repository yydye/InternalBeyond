# P32-W.2 · Tauri Host Integration

审计日期：2026-09-21  
结论：P32-W.2 CLOSED

## A. Resume Preconditions

P32-W.2A and P32-W.2B are CLOSED/PASS. Existing Inno remains the sole production installer, updater target and uninstaller authority. root VERSION remains the only version authority. Tauri NSIS remains development/packaging acceptance only. The P32-W.2A identity, registry, filesystem, shortcut, artifact and exact-cleanup guards were retained.

## B. Host Build Audit

Host source/config inputs are src-tauri/Cargo.toml, Cargo.lock, build.rs, tauri.conf.json, src-tauri/src and the canonical release whitelist. The stable helper materializes a bounded Cargo mirror from the release whitelist plus src-tauri source/config, then runs:

~~~text
cargo build --release --locked --manifest-path src-tauri/Cargo.toml
~~~

The mirror is build-only and removed after the verified EXE is copied out. No Cargo target directory is installed.

## C. Stable Host Distribution Contract

The production Host distribution contains exactly one native file:

~~~text
internalbeyond-host.exe
~~~

Final Host evidence:

~~~text
version = 1.0.6
bytes  = 9,081,856
sha256 = 7e9ab48e25ee3b1a3e1de700d799f19c6bfdb2b560a82a8a3d30bffaa714b776
~~~

The file is staged at the canonical Inno payload root. Cargo target internals, _up_, resources and .tauri-frontend are not installed.

## D. One Web Core Contract

The canonical install contains one Web Core at the install root:

~~~text
InstallRoot/
  internalbeyond-host.exe
  InternalBeyond.html
  assets/
  apps/
  runtime/
  services/
  bridge/
  active/
  docs/
~~~

The install audit found no _up_ directory, second InternalBeyond.html or duplicate assets/apps tree. Tauri NSIS retains its own _up_ acceptance layout only and is not consumed by production Inno.

## E. Resource Resolution

src-tauri/src/lib.rs now prefers an executable/install root containing InternalBeyond.html and runtime/launch-internal-beyond.js before Tauri resource/_up_ candidates.

Resolution policy:

~~~text
canonical Inno: executable/install root
Tauri NSIS acceptance: resource_dir/_up_ fallback
development: explicit IB_PROJECT_ROOT/debug root
~~~

.tauri-frontend remains build staging only. It is not installed or required by the canonical Inno Host.

## F. Version Authority

The Host PE ProductVersion is checked against root VERSION by scripts/stage-tauri-host.ps1. Cargo version remains a build-time mirror/check. VERSION trailing-newline baseline was not changed.

## G. Inno Integration

installer/InternalBeyond.iss now installs and launches internalbeyond-host.exe from the canonical root through Start Menu, Desktop, finish-page and updater-relaunch entries. The VBS launcher remains in the payload as fallback/legacy code but is no longer the canonical shortcut target.

scripts/build-installer.ps1 stages/verifies the Host before payload-manifest creation. The generated payload manifest declares internalbeyond-host.exe, so upgrade stale-file ownership remains manifest-driven.

## H. WebView2 Responsibility

Existing Inno now owns WebView2 responsibility:

1. Detect Evergreen Runtime through Microsoft EdgeUpdate registry locations.
2. If absent, download only the fixed HTTPS Microsoft Evergreen bootstrapper URL.
3. Run the bounded silent per-user install command.
4. Fail with a clear message if download, execution or post-install detection fails.

The acceptance machine detected WebView2 version 153.0.4234.48. A missing-runtime fresh-machine matrix was not simulated; the policy is statically implemented and current-runtime detection passed.

## I. Canonical Entry Point

Production shortcuts target:

~~~text
InstallRoot\internalbeyond-host.exe
~~~

Browser fallback and the VBS fallback file remain available.

## J. Browser Fallback

The existing Browser path remains http://127.0.0.1:23120/InternalBeyond.html. The Host reuses the existing launcher/Web Core and does not migrate localStorage or IndexedDB.

## K. Host Lifecycle Ownership

The Host reuses healthy existing services, starts the existing launcher only when needed, records ownership through the existing boot-state authority, and owns only the launcher/runner it proves it started. Bridge, Active, Home Node and static services remain shared/external authorities.

## L. Exact Stop Contract

ib-stop.js recognizes the Host only when its executable path equals current install root plus internalbeyond-host.exe. After cooperative service stop it kills only the exact verified Host PID/tree. No image-name kill is used. Real running upgrade and uninstall passed this path.

## M. Security / Capabilities

No high-risk Tauri capability was added. core:default and window-state:default remain the capability boundary. No fs root, shell, opener, admin, registry-arbitrary or updater capability was introduced. External URL policy remains HTTP/HTTPS only.

## N. Project Knowledge

Installed Host acceptance passed Browser Project Knowledge status, list, search and read endpoints. The existing Rust and Browser adapters retain read-only allowlist, canonical path, symlink rejection and bounded read/search rules.

## O. P31 Direct Channel

The installed Web Core document route with ?middlebrain returned HTTP 200 and existing P31 contracts remain unchanged. Full packaged DOM interaction coverage was not driven; live Astra calibration was not run without authorized credentials. These remain honest DEGRADED coverage items, not Host/installer/lifecycle blockers.

## P. Fresh Install

Test-only install audit passed 22/22. It verified Host presence, one Web Core, runtime/services/Bridge/Active/docs, runtime dependencies, test registry lifecycle, shortcut isolation and user-data preservation.

## Q. Desktop Acceptance

Real Host smoke passed:

- visible/responding Host window titled InternalBeyond;
- second Host launch focuses the existing instance;
- CSS, JS, background and guide assets reachable from installed root;
- Project Knowledge status/list/search/read reachable;
- P31 Direct document route reachable;
- no browser opened.

Prior P32-W window-state acceptance remains valid for the unchanged window-state plugin/code path; a new move/restore matrix was not added to this installer smoke.

## R. Runtime Health

All five required surfaces passed:

~~~text
Web       PASS
Restart   PASS
Bridge    PASS
Active    PASS
Home Node PASS
~~~

The bundled Node and installed runtime root were used; the repository checkout was not a runtime dependency.

## S. Single Instance / Window State

Single-instance focus passed: the second Host launch did not create a second active Host and the first Host remained alive. Window-state plugin/configuration from P32-W remains intact without storage authority changes.

## T. Running Upgrade

Real Host smoke passed 43/43:

- running-instance Inno upgrade;
- exact Host/runtime stop and file release;
- unrelated decoy Node survival;
- runtime/VERSION replacement;
- user sentinel preservation;
- no browser opening.

## U. Uninstall / Data Preservation

The test-only uninstaller passed: Host/product files removed, test registry and shortcuts removed, user data/sentinel preserved, and production/Tauri keys untouched.

## V. Production Invariance

Final checks confirmed production Inno/Tauri registry, production shortcuts, production roots, VERSION, production installer, SHA256SUMS.txt and update-stable.json were unchanged. [local path redacted], [local path redacted] and real user data were not deleted or modified by the acceptance cleanup.

## W. Cleanup

Removed only test-owned install/data roots, test registry/shortcuts, test Host/runtime processes, test build output, bounded Host build mirror/probe roots and test setup logs. The P7 smoke ledger retains test budget records and is not production release metadata.

## X. Remaining

Non-core DEGRADED items remain:

1. Full packaged DOM interaction matrix across every business page.
2. Live Astra calibration requiring user-provided authorized credentials.
3. Browser/Tauri localStorage/IndexedDB split.
4. Signing, formal updater, tray/deep-link/native capability work.
5. Missing-WebView2 fresh-machine simulation.

VERSION trailing newline and seven BOM baseline failures remain unchanged and out of scope.

## Closure Gate

~~~text
P32-W.2 = CLOSED
Existing Inno = sole production installer, upgrade authority, uninstall authority and Host deployment authority
Tauri NSIS = development / packaging acceptance only
Canonical Web Core = one installed root tree
Stable Host Distribution = proven
Host launch/health/single-instance/upgrade/uninstall = proven
Production invariance = proven
Exact cleanup = proven
~~~

P32-W.2 CLOSED.

Existing Inno is the sole production installer, upgrade authority, uninstall authority, and deployment authority for the Tauri Host.

The Tauri Host consumes the canonical Existing Inno Web Core/runtime without creating a second production resource tree.

Tauri NSIS remains a development / packaging acceptance artifact only.
