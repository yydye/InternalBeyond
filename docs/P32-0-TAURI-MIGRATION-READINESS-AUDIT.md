# P32-0 · Tauri 2 Migration Readiness Audit

状态：P32 第一阶段只读审计基线。本文记录 2026-09-21 在当前工作树上的事实；不把现有 P31 未提交改动重写或合并成 P32。

## 0. 审计边界与工作树状态

- 当前分支：`master`，`HEAD=764a842`。
- 工作树在审计开始前已经存在大量未提交的 P31 及其他阶段改动；因此下面的结论以工作树中“当前生产代码”为准，而不是只看 `HEAD`。
- 审计开始时仓库没有 `src-tauri/`、`Cargo.toml`、`tauri.conf.json` 或 Node 前端包管理入口；现有 Web Core 是 `InternalBeyond.html` 加载的一组原生 JavaScript/CSS 文件。
- P32 不迁移 Chat、Memory、Economy、Home Node 或 P31 Direct transcript 的 authority。

## A. Runtime / process / port topology

端口注册表是当前本地长生命周期组件的事实清单：`runtime/component-registry.js:191-375`；runner 的停止/健康路径与之对应：`runtime/component-lifecycle.js:127-131`。生产代码确认如下。

| Capability / service | Current authority | Current transport | Current process | Current port | Browser dependency | Filesystem dependency | Background dependency | Tauri migration risk | Android risk |
| --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- |
| Main Web UI / Web Core | Browser UI + existing domain modules | Static HTTP; direct `file://` is also supported | `services/internal-beyond-server.js` | 23120 (`IB_WEB_PORT`) | Yes: DOM, IndexedDB, localStorage, Web APIs | Project root served read-only; local mirrors/export | Launcher/runner starts or reuses it | Low for loading; medium for URL/CORS | WebView and asset packaging |
| Bridge | Bridge routes/tools and its configured integrations | HTTP REST + hand-written RFC6455 WebSocket | `services/ib-bridge-service.js` | 23115 (`IB_BRIDGE_PORT`) | Fetch/WebSocket; Origin checks | Bridge data/config/credential vault | Persistent process; proactive timer | Medium: Tauri Origin must be accepted; keep Bridge sidecar | LAN/mobile strategy already separate |
| Active Companion | Active message plans, Moments scheduler, delivery traces, Economy command client | HTTP REST | `services/active-message-service.js` | 23114 (`IB_ACTIVE_PORT`) | Fetch; browser can close while service continues | Active persistence and scheduler state | Yes: proactive/background scheduler | Medium: keep as sidecar in P32 | Background limits are high |
| Home Node | Canonical Chat authority; canonical Memory/Understanding/Moments/Economy stores | HTTP JSON; mobile gateway; bounded read/write seams | `services/home-node-service.js` | 23118 (`IB_HOME_NODE_PORT`) | Fetch + CORS + in-memory desktop credential | SQLite under `%LOCALAPPDATA%\InternalBeyond\home-node` (`services/home-node-service.js:21,109-114`) | Persistent canonical service | Medium: Tauri remains a client; do not move authority into Rust | Existing Android thin client remains independent |
| Restart control plane | Runner lifecycle authority | HTTP control endpoints | `runtime/local-services-runner.js` | 23116 (`IB_RESTART_PORT`) | Fetch from diagnostics only | Boot/recovery/log state | Runner supervises child services | Low; Tauri does not replace it in P32 | Defer |
| Vision | Qwen2.5-VL local worker | HTTP POST `/vision` | Python uvicorn (`scripts/windows/start-vision-service.cmd:48-49`) | 8765 (`IB_VISION_PORT`) | Fetch + image upload | Python model/cache | Optional long-running worker | Keep sidecar; no Rust rewrite | Defer / Android substitute |
| VoiceBox | Optional local voice provider | HTTP/WS provider API | External local provider | 17493 default (`bridge/voicebox.js:27`) | Bridge-mediated; no direct UI authority | Provider-owned | Provider-owned | Keep sidecar/provider | Unsupported until separately designed |
| Local model | Optional Ollama / compatible server | HTTP OpenAI-compatible API | External local process | 11434 default (`assets/js/local-first.js:9`) | Direct fetch through existing provider seam | Provider-owned | Provider-owned | Keep web/provider seam | Android substitute/defer |
| Provider calls | Existing `IBModelCore`/Astra adapter authority | HTTPS/HTTP provider requests, Bridge-aware where applicable | Web Core or Bridge according to existing path | Provider-defined | Fetch/AbortController | API settings already have existing storage rules | No new P32 worker | Keep web/provider seam; do not create second provider layer | Defer |
| P31 Middle Brain Direct | `middle-brain-direct.js` resolver + canonical Astra call | IndexedDB/localStorage reads, then provider call | Web Core | No dedicated port | Query overlay, localStorage, IndexedDB, fetch | No new filesystem authority | None | Low once Project Knowledge is behind host contract | Same Web Core, capability unavailable until adapter exists |
| WebSocket voice / Bridge sync | Bridge/voice runtime | WebSocket; binary audio frames | Bridge + Web Core | 23115 | `WebSocket`, MediaDevices, AudioWorklet | Blob/object URLs only | Voice session lifetime | Medium: CORS/Origin and microphone permissions | High lifecycle/permission risk |
| SSE / stream | No production browser `EventSource` consumer found in the current Web Core; Android uses its own Home Node SSE client | Android-only OkHttp/SSE path in current tree | Android thin client | Home Node endpoint | Not a current Web Core dependency | Android cache | Android lifecycle | No P32 migration needed | Existing Android lifecycle contract |

Confirmed listener sites: static server `services/internal-beyond-server.js:353,371,541`; Bridge `services/ib-bridge-service.js:31,1021,1090`; Active `services/active-message-service.js:26,460`; Home Node `services/home-node-service.js:109-110,1339`; restart plane `runtime/local-services-runner.js:117,1111`; Vision `scripts/windows/start-vision-service.cmd:48-49`.

### Background and launcher chain

The launcher uses the registry and starts/reuses the static server and local service runner (`runtime/launch-internal-beyond.js:42-54`, `runtime/component-registry.js:191-375`). Active scheduling is real service work, not a browser-only timer (`services/active-message-service.js:195-460`). P32 therefore keeps the existing launcher, runner, Bridge, Active, Home Node and optional workers; Tauri is a host WebView and does not silently spawn a duplicate service graph.

## B. Browser API audit

The following is the production-code classification. “Browser exists” is not treated as proof that Windows WebView2 or Android WebView preserves the current behavior; the current call pattern and required permission/lifecycle are included.

| API / pattern | Evidence | Classification | Reason |
| --- | --- | --- | --- |
| `indexedDB` | `assets/js/core.js:3-18` | `KEEP_WEB` | Chat, Memory, active domains and many stores already use this authority/mirror path; P32 must not change DB version or schema. |
| `localStorage` | `assets/js/middle-brain-direct.js:23,163-221`; `assets/js/home-node-client.js:12-15,50-64` | `KEEP_WEB` | P31 transcript and existing local configuration have explicit namespaces; do not move them into Rust. |
| `fetch` / `AbortController` | `assets/js/home-node-client.js:120-221`; `assets/js/middle-brain-astra.js:127-167` | `HOST_ADAPTER` for host-owned calls, otherwise `KEEP_WEB` | Existing provider and Home Node seams remain; host-origin/CORS compatibility is needed for Tauri. |
| `WebSocket` | `assets/js/communication/call.js:84-129`; `assets/js/bridge.js:108` | `HOST_ADAPTER` boundary for local service URL/origin, `SIDECAR` for Bridge | The current Bridge protocol is already a sidecar contract; no Rust rewrite in P32. |
| `EventSource` | No current production Web Core match; Android has its own SSE parser | `KEEP_WEB` / `DEFER` | Not a current desktop dependency. |
| `navigator.mediaDevices.getUserMedia` | `assets/js/communication/voice.js:29,305`; `assets/js/communication/video-runtime.js:56-66` | `NEEDS HOST ADAPTER` | Windows WebView2 and Android WebView require permission and lifecycle handling; keep the current Web API path behind capability reporting. |
| `AudioContext` / `AudioWorklet` | `assets/js/communication/voice.js:91`; `assets/js/communication/call.js:93-105` | `NEEDS HOST ADAPTER` | Requires secure/localhost-like origin and device permission; existing static localhost path remains supported. |
| `Notification` / `speechSynthesis` | `InternalBeyond.html:944`; `assets/js/bridge.js:1054-1063` | `TAURI_PLUGIN` or `ANDROID_SUBSTITUTE`, currently `KEEP_WEB` | Permission and background behavior differ; no P32 native rewrite. |
| Clipboard | Production references are browser `navigator.clipboard`/copy fallbacks in UI helpers | `HOST_ADAPTER` | The contract exposes clipboard; existing Web behavior remains the Browser adapter. |
| `File`, `Blob`, `FileReader`, object URLs | `assets/js/communication/voice.js:380-416`; `assets/js/bridge.js:56-70,891`; `apps/ib-media-adapter.js:43-66` | `KEEP_WEB` | Used for request-local media and preview/playback; not filesystem authority. |
| file/directory pickers and download | `apps/ib-app-cinema.js:134`; `assets/js/diagnostics.js:1026-1030`; workspace modules | `HOST_ADAPTER` | Browser APIs are optional in WebView2/WebView. The first native capability is not a general file manager. |
| `window.open`, `location`, `history` | `assets/js/middle-brain-direct.js:697-720,759-765`; site operations | `KEEP_WEB` with route abstraction | P31 query overlay must keep `?middlebrain` and existing hash semantics; no second Tauri route. |
| Canvas/video/fullscreen/drag-drop | `apps/ib-app-cinema.js:109,134,144`; `assets/js/communication/video-runtime.js:75-88` | `NEEDS HOST ADAPTER` | Rendering remains Web Core; device permission and fullscreen policy are host-specific. |
| service worker | No current production consumer found | `DEFER` | No P32 dependency. |

## C. Localhost dependency audit

| Caller | Endpoint | Port | Purpose | Authority | Can move into Rust? | Must stay sidecar? | Android feasibility |
| --- | --- | ---: | --- | --- | --- | --- | --- |
| launcher / Web Core | `http://127.0.0.1:<IB_WEB_PORT>` | 23120 | static UI, `/health`, update surfaces | static server | No need; Tauri bundles the same Web Core for packaged builds | Existing browser mode keeps it; Tauri dev may use it | Tauri Android can load bundled assets; localhost dev is not the product path |
| `assets/js/bridge.js`, call runtime | `http://` / `ws://127.0.0.1:<IB_BRIDGE_PORT>` | 23115 | tools, sync, TTS, voice call | Bridge | No; protocol and integrations already form a sidecar boundary | Yes in P32 | LAN/mobile strategy separate; loopback is not a phone architecture |
| `assets/js/active-diary.js`, scheduler | `http://127.0.0.1:<IB_ACTIVE_PORT>` | 23114 | active plans, moments, delivery, traces | Active companion | No; background process must survive WebView close | Yes | High lifecycle risk; defer |
| `assets/js/home-node-client.js` | `http://127.0.0.1:<IB_HOME_NODE_PORT>` | 23118 | canonical Chat/Memory/Understanding/Moments/Economy reads/writes | Home Node SQLite | No in P32 | Yes | Android already uses a thin Home Node client and device token |
| diagnostics / restart | `http://127.0.0.1:<IB_RESTART_PORT>` | 23116 | status/restart/shutdown | local-services-runner | No | Yes | Defer |
| `assets/js/communication.js` | `http://127.0.0.1:8765/vision` | 8765 | optional local image understanding | Vision sidecar | No | Yes | Android substitute/defer |
| `bridge/voicebox.js` | `http://127.0.0.1:17493` | 17493 | optional local voice provider | external provider | No | Yes | Unsupported until a mobile provider strategy exists |
| `assets/js/local-first.js` | `http://127.0.0.1:11434/...` | 11434 | Ollama local model | external provider | No | Yes | Android substitute/defer |

The current code does not treat 23115, 23114 or 23118 as stale documentation: the executable listener and registry paths above still use them. P32 does not delete or renumber them.

## D. Storage authority audit

| Domain | Current authority | Current mirror / fallback | P32 decision |
| --- | --- | --- | --- |
| Chat | Home Node SQLite in canonical mode; browser `chatMessages` remains the existing local/mirror path (`assets/js/core.js:57-69`, `assets/js/chat-authority.js`) | IndexedDB mirror and existing `mirror`/`off` modes | `KEEP_WEB` + existing Home Node; no rewrite |
| Memory | Home Node memory store in canonical mode; browser memory authority/mirror seam | IndexedDB `memories` and existing migration path | `KEEP_WEB`; no rewrite |
| Understanding / Threads | Home Node canonical stores and existing browser authorities | IndexedDB stores already in `DB_VER=24` | `KEEP_WEB`; no rewrite |
| Moments / Activity / Diary / Letters | Existing domain authorities and browser stores; Moments has canonical Home Node path and mirror rules | IndexedDB and existing Active/Node projections | `KEEP_WEB` / `SIDECAR`; no rewrite |
| Economy | Home Node Economy SQLite + Bridge/Active command seams | Existing UI projections only | `SIDECAR`; no Rust authority |
| P31 Direct transcript | `localStorage['ib_middle_brain_direct_v1']` (`docs/P31_MIDDLE_BRAIN_DIRECT_CHANNEL.md:40-50`) | None | `KEEP_WEB`; no migration |
| filesystem mirror / backup / export | Existing `core.js` mirror/export/file helpers | localStorage / user-selected file where available | `HOST_ADAPTER` only for future file operations; no authority change |

## E. Host capability matrix

This is the classification permitted by P32. It is intentionally narrower than “move everything native”.

| Capability | Classification | P32 implementation decision |
| --- | --- | --- |
| Existing Web Core / DOM / CSS / IndexedDB / localStorage | `KEEP_WEB` | Load the same `InternalBeyond.html`; do not duplicate or rewrite the UI. |
| Clipboard | `HOST_ADAPTER` | Contract exposes the existing Web clipboard path; native plugin remains deferred. |
| Notifications | `HOST_ADAPTER` | Contract reports WebView capability; native notification plugin is deferred. |
| Open external | `HOST_ADAPTER` | Contract boundary first; Tauri opener plugin is not added just to create a second URL path. |
| File/directory picker and save/export | `HOST_ADAPTER` | Browser APIs remain the first implementation; no arbitrary filesystem command. |
| Project Knowledge | `TAURI_COMMAND` + Browser HTTP adapter | First native capability; read-only allowlisted Rust service and a same-origin Browser adapter share the same contract. |
| Existing local services / WebSocket | `SIDECAR` | Bridge, Active and Home Node stay independent processes with existing ports. |
| Background jobs / proactive messages | `SIDECAR` | Active and runner remain the authority. |
| TTS / ASR / microphone / camera / video | `KEEP_WEB` + `SIDECAR` / `ANDROID_SUBSTITUTE` as applicable | No P32 Rust audio/video rewrite. |
| Updater / launcher / logs / diagnostics | `KEEP_WEB` + existing launcher/runner | Tauri does not replace installer or recovery control plane in P32. |

## F. Security and stop-condition result

- Project Knowledge is read-only. No `writeProjectDoc`, `deleteProjectDoc`, `execute`, `shell`, `arbitraryRead`, or filesystem-root command is allowed.
- Browser mode remains supported; the Browser adapter uses same-origin read-only endpoints only when the existing static server is present. `file://` without the static server reports the capability unavailable rather than inventing a path.
- Tauri uses a custom command only for the allowlisted project-document service. The command receives a document id from the indexed allowlist, never an arbitrary filesystem path.
- Canonicalization and symlink checks are required before any read. `.git`, `node_modules`, virtual environments, credentials, `.env`, logs, databases, backups and uploads are excluded.
- Adding `tauri.localhost` to the existing local Origin allowlists is an additive transport compatibility change; it does not bypass Home Node/Bridge tokens, LAN binding, or service authorization.
- No frozen P31 prompt/provider/storage contract needs to change. No storage authority migration, Home Node deletion, Bridge deletion, or Android architecture fork is required.
- Android cannot proceed beyond readiness in this environment: `java`, `adb`, Android SDK/JDK probes are unavailable. No large toolchain installation is authorized by this phase.

## G. Audit conclusion

The safe P32 implementation boundary is:

```text
existing InternalBeyond Web Core
             ↓
       IB.host contract
        ↙          ↘
Browser/static      Tauri 2
adapter             adapter → read-only Project Knowledge command
                         ↓
                    Rust allowlisted index
```

The existing runtime graph remains in place. P32 may add the host contract, a minimal Tauri 2 skeleton, the Project Knowledge capability, additive Tauri-origin compatibility, and focused tests. It must stop before storage rewrites, service deletion, or formal Android product work.
