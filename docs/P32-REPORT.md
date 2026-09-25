# P32 · Tauri 2 Host Foundation Report

日期：2026-09-21  
状态：Windows-first Host Foundation 完成；Android 停在 readiness（工具链缺失）。  
范围：本报告只记录 P32；工作树中原有未提交的 P31 及其他阶段改动保持原状。

## A. Runtime Audit

基线：`master`，`HEAD=764a842`。审计时工作树已很脏，不能把现有 P31 改动重写成 P32。完整的 file:line 审计见 [P32-0 audit](P32-0-TAURI-MIGRATION-READINESS-AUDIT.md)。

| Capability | Current authority | Transport / process | Port | Browser / filesystem / background | Tauri / Android risk |
| --- | --- | --- | ---: | --- | --- |
| Main Web Core / Home UI | existing HTML + browser modules | static server | 23120 | DOM/Web APIs; project root is read-only served content; launcher-owned | Tauri asset loading; Android WebView |
| Bridge / WebSocket / TTS tools | Bridge | HTTP + hand-written RFC6455 WS | 23115 | Fetch/WebSocket; bridge config and provider-owned files; persistent process | keep sidecar; mobile loopback is not a LAN strategy |
| Active Companion | Active service | HTTP + scheduler | 23114 | fetch; active persistence; real background work | keep sidecar; Android lifecycle risk |
| Home Node / canonical Chat/Memory/Understanding/Moments/Economy | Home Node SQLite | HTTP JSON + mobile gateway | 23118 | fetch + token; `%LOCALAPPDATA%\InternalBeyond\home-node`; persistent | keep authority; do not delete or rewrite |
| Restart / launcher control plane | local runner | HTTP control | 23116 | diagnostics fetch; boot/recovery/log state; supervisor | keep existing launcher/runner |
| Vision | Python worker | HTTP POST | 8765 | fetch/image upload; model/cache; optional worker | sidecar / Android substitute later |
| VoiceBox / local model | external providers | local HTTP/WS | 17493 / 11434 | Bridge/provider seam; provider-owned; provider lifecycle | defer mobile/provider strategy |
| Middle Brain / Astra / P31 Direct | existing Web Core provider seams | local reads + canonical provider call | none | IndexedDB/localStorage/fetch; existing storage; no new worker | host adapter only; provider seam unchanged |
| Cinema / co-read / Memory / Economy / Role DM / Moments / Diary | existing Web/domain authorities | browser modules plus existing service seams | none dedicated | Web APIs and existing stores; domain schedulers where applicable | keep Web/sidecars |
| Event stream | no desktop `EventSource` consumer found; Android has its own SSE path | Android thin-client SSE | Home Node | Android lifecycle/cache | Android-only today |
| filesystem / clipboard / notification / external open | existing Web API fallbacks | browser APIs | none | permission- and WebView-dependent; no new authority | `IB.host` boundary; native plugins deferred |

Existing listener evidence: static `services/internal-beyond-server.js`, Bridge `services/ib-bridge-service.js`, Active `services/active-message-service.js`, Home Node `services/home-node-service.js`, runner `runtime/local-services-runner.js`, and Vision startup script. P32 does not add a duplicate service graph.

## B. Capability Matrix

| Capability | Classification | P32 decision |
| --- | --- | --- |
| DOM/CSS/IndexedDB/localStorage/fetch | `KEEP_WEB` | same `InternalBeyond.html`; no storage migration |
| filesystem general access | `DEFER` | no general filesystem command |
| Project Knowledge | `TAURI_COMMAND` + Browser adapter | first native capability; read-only allowlist |
| clipboard / notifications / open external | `HOST_ADAPTER` | existing Web implementation exposed through contract; Tauri plugins deferred |
| file picker / directory picker / save-export | `HOST_ADAPTER` | browser API fallback only in P32 |
| local services / WebSocket | `SIDECAR` | Bridge, Active, Home Node, runner and workers stay separate |
| background jobs / proactive messages | `SIDECAR` | Active and runner remain authorities |
| TTS / ASR / microphone / camera / video | `KEEP_WEB` + `DEFER` | permissions/lifecycle audited, no Rust rewrite |
| image input / Vision | `SIDECAR` | existing Web + Vision path preserved |
| updater / launcher / logs / diagnostics | `KEEP_WEB` + `SIDECAR` | existing control plane preserved |
| Android-specific notification/background/deep-link strategy | `ANDROID_SUBSTITUTE` / `DEFER` | no product fork in P32 |

## C. Host Architecture

```text
existing InternalBeyond Web Core
              |
           IB.host
        /            \
Browser / Home Node  Tauri 2
adapter               adapter
same-origin HTTP      tauri::invoke
                         |
                Rust Project Knowledge
```

`assets/js/host-capability.js` is the only Browser/Tauri runtime switch in the Web Core. Business modules consume `IB.host.platform()`, `IB.host.capabilities()`, `IB.host.files`, `IB.host.notifications`, `IB.host.clipboard`, `IB.host.external`, and `IB.host.projectKnowledge`.

The Browser adapter uses the existing static server's same-origin `/__project-knowledge/*` endpoints. The Tauri adapter invokes the four registered commands. Existing services additionally accept `http://tauri.localhost` without weakening their existing tokens, loopback binding, or authorization checks.

## D. Tauri

Implemented manually; `tauri init` was not run and no second HTML/CSS/JS tree was created.

- Tauri crate: `2.11.6`; `tauri-build`: `2.6.3`; CLI used for acceptance: `tauri-cli 2.11.4`.
- `src-tauri/Cargo.toml`, `build.rs`, `src/main.rs`, `src/lib.rs`, `src/project_knowledge.rs`.
- `src-tauri/tauri.conf.json`: development URL `http://127.0.0.1:23120/InternalBeyond.html`; packaged frontend paths are the existing `InternalBeyond.html`, `assets`, `active`, `apps`, and `game`; `docs` and `README.md` are declared resources.
- `src-tauri/capabilities/default.json`: only `core:default`; no shell, fs, opener, notification, or arbitrary command permission.
- Existing `assets/icons/IB-icon.ico` is reused as `src-tauri/icons/icon.ico`.
- `bundle.active=false` keeps this phase at host foundation/dev acceptance; installer/signing is later work.

Tauri command wiring follows the Tauri 2 command/invoke model and the v2 config model: [calling Rust commands](https://v2.tauri.app/develop/calling-rust/) and [Tauri v2 configuration](https://v2.tauri.app/reference/config/).

## E. Project Knowledge

The Browser/Home Node resolver is `services/project-knowledge.js`; Rust mirrors the same contract in `src-tauri/src/project_knowledge.rs`.

- Allowlist: `docs/**/*.md|markdown|txt` and root `README*`/`GUIDE*` text files.
- Denylist: `.git`, `node_modules`, virtual environments, credentials, `.env`, logs, database/backup/upload areas, `browser-data`, `dist`, and `target`.
- Symlinks are rejected. Every indexed/read path is canonicalized and checked to remain inside the configured root/resource root.
- Bounds: max 512 docs, max 1 MiB per doc, max 8 search results, max 420-character snippets, max 32,000-character reads.
- Index fields: `docId`, relative path, title, headings, sections, authority, mtime/update time, and SHA-256 hash.
- Authority: `CANONICAL > CURRENT > HISTORICAL`; contract/canonical/architecture paths rank canonical, `docs/history/**` and historical/legacy/archive/closure names rank historical, and other allowlisted docs rank current. Authority changes retrieval ranking only.
- Provenance is present in every hit and direct-context line: `source=project_doc`, `docId`, path, section, authority, `updatedAt`, and hash.
- Commands: `list_project_docs`, `search_project_docs`, `read_project_doc`, `project_knowledge_status`. No write/delete/execute/shell/arbitrary-read command exists.
- Probe status exposes indexed, canonical, current, historical counts, refresh time, and search status without an Astra/model call.

Current repository snapshot after adding this report: 192 indexed docs, 63 canonical, 66 current, 63 historical; status `ready`.

## F. Middle Brain

P31 was not rewritten. `project_doc` is added as a source family in the existing bounded resolver after Activities and before Moments. The resolver requests bounded search results from `IB.host.projectKnowledge`, maps only returned snippets plus provenance into `project_doc`, then continues through the existing:

```text
Middle Brain Direct
→ bounded Context Resolver
→ directChatSystemPrompt
→ canonical middleBrainModelCall
→ Astra / IBModelCore
```

Budget arbitration is explicit:

- project documents: max 4 selected sources and max 2,600 rendered characters;
- overall P31 context remains max 28 sources, 7,200 characters, and 1,900 estimated tokens;
- when both families hit, a project floor of 420 characters and a World Context floor of 900 characters are reserved when available, then remaining capacity competes by relevance;
- dedupe, per-type caps, authority bonus, relevance, and provenance are retained.

The required Economy queries were run through the real resolver. The first query returned project-doc hits with `HISTORICAL`, `CANONICAL`, and `CURRENT` authority; the follow-up returned canonical/current distinctions. No model call was made by Project Knowledge.

## G. Security

- The browser and Tauri APIs accept a document id from the indexed allowlist, never a filesystem path from Astra or the UI.
- Canonicalization plus symlink rejection prevents `../`, absolute-path, and link escapes.
- The Rust state owns the root; the frontend never receives a filesystem root.
- The Tauri capability file has only `core:default`; no shell, fs, opener, credential, or arbitrary command permission.
- Existing Home Node/Bridge token checks, localhost binding, and service authorization remain in place. Tauri-origin acceptance is additive transport compatibility only.
- P31 transcript, IndexedDB, localStorage, Chat, Memory, Economy, Home Node, Bridge, and Active authorities were not moved.

## H. Windows Acceptance

Real Windows dev launch completed with `cargo tauri dev` while the existing static server remained at PID 18872.

- Host process: `internalbeyond-host.exe`, PID 35496.
- Window title: `InternalBeyond`.
- `Responding=True`, `HasExited=False` during the smoke check.
- A direct Edge WebView2 child was observed with `--webview-exe-name=internalbeyond-host.exe` and the app user-data path `com.internalbeyond.desktop`.
- Existing Web Core health: `http://127.0.0.1:23120/health` returned `{"ok":true,"server":"InternalBeyond Web","version":"1.0.6"}`.
- Host was stopped by its exact PID; the WebView child exited; existing static PID 18872 was preserved.
- After the final IPC payload correction, a second incremental launch (PID 524) again produced the same responsive `InternalBeyond` window and was also stopped by exact PID.

The launch/UI-host smoke is PASS. Static HTML/script checks and P31 contract tests also pass. A full manual click matrix for every role/chat/group/memory screen was not claimed as a P32 result; that remains a later UI acceptance pass rather than a storage or host-foundation blocker.

## I. Android Readiness

| Capability | Windows | Android | Implementation | Permission / lifecycle risk | Status |
| --- | --- | --- | --- | --- | --- |
| Web Core / IndexedDB / localStorage | WebView2 + existing Web Core | Android WebView target remains same asset contract | keep Web Core | WebView storage lifecycle | readiness only |
| Project Knowledge | Rust command | same command shape intended | Tauri command | resource-root packaging | Rust contract ready; Android build not initialized |
| local services / localhost | loopback sidecars | existing thin-client/Home Node strategy | sidecar/LAN strategy | loopback is not phone architecture | defer |
| notifications/background | Web/host adapter | Android substitute needed | future plugin/Android API | permission and battery restrictions | defer |
| microphone/camera/TTS/ASR | existing Web/provider paths | Android permission/lifecycle strategy needed | keep Web + substitute later | high | defer |
| file picker/deep links/network/WS/cleartext | existing Web/sidecar | requires Android policy review | future host adapter | medium/high | defer |

Environment probe: `java` missing, `adb` missing, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `JAVA_HOME`, and `NDK_HOME` unset; only `x86_64-pc-windows-msvc` Rust target installed. No Android toolchain was downloaded and no architecture fork was introduced.

## J. APK

No APK was generated in this turn. The pre-existing ignored file `dist/android/internalbeyond-1.0.0-m1c-debug.apk` (10,423,736 bytes, dated 2026-09-11) was not treated as a P32 build and was not smoke-tested. Missing JDK/Android SDK/`adb` is the explicit blocker.

## K. Files

P32 additions:

- [P32-0 audit](P32-0-TAURI-MIGRATION-READINESS-AUDIT.md)
- [P32-2 host foundation notes](P32-2-TAURI-HOST-FOUNDATION.md)
- this report
- `src-tauri/` Cargo/Tauri configuration, capability manifest, reused icon, host entrypoint, and Rust Project Knowledge service
- `runtime/host-origin.js`
- `services/project-knowledge.js`
- `tests/test_project_knowledge.js`

P32 integration edits:

- `InternalBeyond.html` loads `assets/js/host-capability.js` before business modules.
- `assets/js/host-capability.js`, `assets/js/middle-brain-direct.js`, and `assets/css/core/middle-brain-direct.css` provide the host/direct-channel seam in the existing P31 worktree.
- `services/internal-beyond-server.js` adds same-origin read-only Project Knowledge routes.
- Origin compatibility is added to `active/http.js`, `bridge/config.js`, `services/home-node/http.js`, `services/ib-bridge-service.js`, `runtime/service-control.js`, and `runtime/local-services-runner.js`.
- `.gitignore` excludes `src-tauri/target/` and `src-tauri/gen/`.

No existing Home Node, Bridge, Active Companion, UI page, storage authority, or provider layer was deleted.

## L. Tests

| Test / check | Result |
| --- | --- |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | PASS |
| `cargo check --manifest-path src-tauri/Cargo.toml` | PASS |
| `cargo tauri build --debug` | PASS: config/resources/icon build validation; no installer emitted because `bundle.active=false` |
| `cargo tauri --version` | PASS (`tauri-cli 2.11.4`) |
| `node tests/test_project_knowledge.js` | PASS: list/search/read/allowlist/traversal/provenance/authority/Browser/Tauri parity/budget |
| `node tests/test_middle_brain_direct.js` | PASS: existing P31 suite |
| `node scripts/scripts_check_html.js InternalBeyond.html` | PASS: 135 local scripts, 0 failed |
| `node tests/test_runtime_integration_audit.js` | PASS: 0 failed |
| real `cargo tauri dev` Windows launch | PASS: host window + WebView2 observed |
| `node tests/test_frontend_structure.js` | FAIL: 7 pre-existing BOM baseline failures in already-dirty files: `economy-shell.css`, `autonomy-core.js`, `communication.js`, `economy-configuration-core.js`, `economy-shell-core.js`, `economy-shell.js`, `home-node-client.js` |

The seven BOM failures were present in files already modified before P32 and were intentionally not repaired as unrelated baseline work. The new P32 Web Core files satisfy the BOM check.

## M. Resource Cleanup

- Reused existing static server PID 18872; it was not started or stopped by this pass.
- Started Tauri dev hosts PID 35496 and, after the IPC correction, PID 524; both were stopped exactly by PID after acceptance.
- Its observed WebView2 child exited with the host; no process-name-wide `taskkill` was used.
- Node Project Knowledge tests used temporary OS directories and removed them in `finally`.
- Cargo `target/` and generated Tauri schemas remain ignored build cache, not tracked product files.
- No push and no commit were performed.

## N. Remaining

- Install/provide JDK, Android SDK/NDK, Gradle prerequisites, Rust Android targets, and `adb` only when Android build work is explicitly authorized; then run a separate readiness/APK smoke pass.
- Decide later whether native clipboard, notifications, external-open, and file-dialog plugins are needed; P32 deliberately keeps stable Web APIs.
- Perform the full interactive Windows click matrix and packaged/signing/installer acceptance in a later host-release phase.
- Existing seven BOM baseline failures remain outside P32 scope.

P32 stops here; no P33 work was started.
