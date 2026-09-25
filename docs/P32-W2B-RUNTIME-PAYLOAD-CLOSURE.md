# P32-W.2B · Runtime Payload Closure

审计日期：2026-09-21  
结论：**PASS**

## A. Starting State

P32-W.2A 的 registry/filesystem isolation 与 install/uninstall audit 已通过，但 real runtime launch 因以下链路失败而为 DEGRADED：

~~~text
installed runtime/service-control.js
        ↓ require("./host-origin.js")
        ↓
[runtime/host-origin.js absent from release whitelist]
~~~

P32-W.2B 只处理 runtime payload closure，不进入 Tauri Host Distribution Contract、P33、Android 或 storage migration。

## B. Dependency Audit

### runtime/host-origin.js

- 状态：untracked dirty-worktree file；无 Git history commit。
- Authority evidence：header 为 P32 Host-origin compatibility；实现只有 TAURI_ORIGIN_RE 与 isTauriOrigin()，见 runtime/host-origin.js:1-21。
- Production consumers：runtime/service-control.js:49、runtime/local-services-runner.js:39、active/http.js:8、bridge/config.js:12、services/ib-bridge-service.js:901、services/home-node/http.js:51、services/internal-beyond-server.js:75。
- 它不是 Tauri-only dependency，而是 Browser/static server、Bridge、Active、Home Node 与 installer stop-control 共用的 origin helper。
- 它只访问字符串；无 environment、filesystem、registry、network、secret、Tauri API 或副作用。

### services/project-knowledge.js

- 状态：untracked dirty-worktree P32 file；无 Git history commit。
- Header 将它定义为 Browser/Home Node Project Knowledge adapter，见 services/project-knowledge.js:1-9。
- Production static server 在 services/internal-beyond-server.js:76 顶层 require 它。
- 它只 require builtin crypto/fs/path，见 services/project-knowledge.js:12-14；实现是 read-only、allowlist、canonical-path checked。
- P32 authority report 明确把它定义为 Browser Project Knowledge adapter，并由 Tauri Rust counterpart mirror：docs/P32-REPORT.md:74-76、docs/P32-W-WINDOWS-TAURI-PRODUCTIZATION.md:144-146。

两者均分类为 PRODUCT/RUNTIME FILE，不是 test-only dependency，也不应 inline。

## C. Source vs Packaged Graph

Source graph：

~~~text
启动 InternalBeyond.vbs
        ↓
runtime/launch-internal-beyond.js
        ├── runtime/local-services-runner.js
        │       ├── runtime/component-lifecycle.js
        │       │       └── runtime/service-control.js
        │       │               └── runtime/host-origin.js
        │       └── runtime/host-origin.js
        └── services/internal-beyond-server.js
                ├── runtime/service-control.js
                ├── runtime/host-origin.js
                └── services/project-knowledge.js
~~~

Before packaged graph：

~~~text
service-control.js → [MISSING runtime/host-origin.js]
internal-beyond-server.js → [MISSING services/project-knowledge.js]
~~~

After closure：

~~~text
release-manifest → staging → Inno payload
  ├── runtime/host-origin.js
  └── services/project-knowledge.js
~~~

## D. host-origin Authority

Decision:

~~~text
HOST_ORIGIN = PRODUCT/RUNTIME FILE
~~~

Evidence is the multiple shipped Node consumers, the pure shared implementation, and the fact that omitting it makes the current production source unloadable. It is not a bundle detail and not a Tauri-only file.

## E. Additional Missing Dependencies

The restricted Node-side closure audit covered shipped runtime/, services/, bridge/, active/ and tools/ files, following literal local CommonJS require calls.

Before the fix it found exactly:

~~~text
runtime/host-origin.js
services/project-knowledge.js
~~~

After the fix it found none. Browser assets were excluded because their client-side module conventions are not Node payload dependencies.

## F. Architecture Decision

Both files belong in the canonical production whitelist. No repository fallback, network download, post-install patch, Tauri _up_ copy, .tauri-frontend copy, bundle or duplicate source was introduced.

## G. Changes

- scripts/release-manifest.js:65 adds services/project-knowledge.js.
- scripts/release-manifest.js:78 adds runtime/host-origin.js.
- installer/InternalBeyond.iss:151 extracts host-origin.js from canonical staging for pre-install stop-helper execution; installer/InternalBeyond.iss:349 extracts the same staged file unconditionally.
- The previous test-only source-path extraction seam was removed.
- tests/test_installer.js:232-258 adds the Node-side dependency closure contract and explicitly requires both files.
- tests/test_installer_smoke.js:992 asserts both files are installed.
- tests/test_installer_smoke.js:1039-1053 loads installed service-control.js with installed bundled Node and asserts the resolved host-origin path.

No runtime business logic, Tauri NSIS source, AppId, VERSION, production registry or production release metadata was changed.

## H. Release Manifest Closure

Read-only resolve and test build results:

~~~text
ok=true
entries=41
files=350
totalBytes=129284997
missing=[]
denied=[]
~~~

Both new files are in the resolved payload. logs, browser-data, user data, tmp, tests, installer source, src-tauri/target and .tauri-frontend remain excluded.

## I. Dependency Contract Test

node tests/test_installer.js:

~~~text
50 passed
1 pre-existing failure: VERSION trailing newline
~~~

The new static dependency closure contract passed. The VERSION failure predates this phase and VERSION was not modified.

## J. Installer Test Build

Test-only canonical build:

~~~text
mode        = -TestMode
compiler    = /DInstallerTestMode=1
output      = tmp/installer-smoke-build/InternalBeyond-Installer-Smoke-Test-Setup-1.0.6.exe
size        = 52,880,667 bytes
sha256      = a3331e49c3c69777c62b0d61f3d033729ca142d8e2e18e64765c206c7b7b89af
update feed = not generated
~~~

Production dist was not an output target and remained byte-identical.

## K. Real Runtime Launch

The real test-only smoke completed 40/40:

- install and payload audit passed;
- Web, Restart, Bridge, Active and Home Node health passed;
- /health, boot-state, document and all 16 guide screenshots passed;
- browser opens remained zero;
- bundled Node was used;
- user data survived upgrade and uninstall;
- test registry lifecycle passed.

## L. Repository Escape Check

The installed bundled Node loaded installed service-control.js and evaluated:

~~~text
require.resolve("./host-origin.js", { paths: [<installed-root>\runtime] })
~~~

The result matched:

~~~text
%TEMP%\ib-p7-smoke\install-...\runtime\host-origin.js
~~~

It did not resolve to E:\InternalBeyond-main\runtime\host-origin.js. The boot record also bound the running instance to the isolated install root.

## M. Runtime Health

All five isolated lifecycle surfaces passed:

~~~text
Web       PASS
Restart   PASS
Bridge    PASS
Active    PASS
Home Node PASS
~~~

The unrelated decoy Node survived upgrade. Cleanup used exact tracked/root-owned PIDs only; no image-name broad kill was used.

## N. Upgrade / Uninstall

The original P32-W.2A sequence continued safely after launch passed:

- running-instance upgrade: PASS;
- runtime release/file replacement: PASS;
- unrelated Node survival: PASS;
- test uninstaller: PASS;
- test registry removal: PASS;
- user data preservation: PASS.

## O. Production Invariance

Final read-only checks confirmed:

~~~text
Production Inno registry before = after = final
Tauri uninstall registry before = after = final
Tauri manufacturer registry before = after = final
[local path redacted] untouched
[local path redacted] untouched
production shortcuts unchanged
VERSION unchanged
production installer/SHA256SUMS/update-stable unchanged
~~~

Production artifact hashes remained:

~~~text
dist/InternalBeyond-Setup-1.0.6.exe  52608553  ffcf9e6a729d97383c5e36c51c80e2dadac3efedafe6f854d1a5c0d65c14eb5c
dist/SHA256SUMS.txt                  406       0dfde9eff3e8545d9ef6a1509aed930de07da5a299988ada162d7517fb90e265
dist/update-stable.json              619       bdddf80ddd1d063e43d4a3a49f0797899853e15324f8acb207d0072ebe97c42c
~~~

## P. Cleanup

Removed after acceptance:

- test install/data roots;
- test-only AppId registry residue;
- test Start Menu launch/uninstall shortcuts and Desktop shortcut;
- test-only build output and setup logs.

The P7 real-smoke ledger retains the successful test artifact hash as harness budget evidence; it is not production release/update metadata. No production registry, install root, shortcut, artifact or user data was deleted.

## Q. Remaining

No P32-W.2B runtime payload blocker remains. The known VERSION trailing-newline static baseline failure remains outside this phase and was not changed.

P32-W.2B does not itself resume P32-W.2. Any later P32-W.2 work must follow the frozen Existing Inno authority and remain separate from Tauri Host integration.

## Closure Gate

~~~text
P32-W.2B = PASS
P32-W.2A = CLOSED / PASS
P32-W.2 may resume = YES, under a later explicit instruction only
~~~

P32-W.2B CLOSED.  
Canonical production runtime payload dependency closure is proven.

P32-W.2A CLOSED.  
Installer smoke isolation and real runtime acceptance are proven.

