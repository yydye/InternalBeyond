# P32-W.3D · Tauri WebView Identity Resolution

审计日期：2026-09-22  
状态：**DEGRADED**

## A. Starting State

P32-W.3C proved a Host-side `INTERNALBEYOND` Started/Finished lifecycle and bounded M3, but reported `origin=null`, `pathname=/`, `tauri=false`, and `navHome=false` from the WebView-side context. W3A was not resumed.

This phase only resolved bounded WebView identity. It did not enter the Secret Route DOM flow and did not modify Secret Route, seven-click, P31, Terminal, installer authority, Stable Host Distribution, storage, Android or P33.

## B. Host Identity

Host configuration uses `src-tauri/tauri.conf.json:5-25`:

```text
frontendDist = ../.tauri-frontend
window.url   = InternalBeyond.html?ib_tauri_host=1
create       = false
```

`src-tauri/build.rs:38-74` prepares `.tauri-frontend` from the installed product root. `src-tauri/src/lib.rs:827-850` classifies the bounded `PageLoadPayload.url()` and records Started/Finished with `documentSeq`.

Final Host evidence:

```text
documentSeq=1
pageLoadPhase=started/finished
urlClass=INTERNALBEYOND
schemeClass=HTTP
```

Host URL identity = **PASS**.

## C. WebView Identity

The fixed Document Probe at `src-tauri/src/lib.rs:138-236` reports only classified/bounded values. Final installed result:

```text
hrefClass=CUSTOM
originClass=OPAQUE
pathnameClass=ROOT
origin=null
pathname=/
readyState=complete
titlePresent=true
bodyPresent=true
ibMarkerPresent=true
ibHostPresent=false
navHome=false
```

The probe never transmitted raw `location.href`, HTML, cookies, storage, chat data or credentials.

WebView context identity = **FAIL to prove canonical Web Core identity**.

## D. Scheme Analysis

Bounded comparison:

| Layer | Scheme/class | Evidence |
|---|---|---|
| Host PageLoad | `HTTP` | `M1B_PAGE_*_SCHEME_HTTP` |
| Host path class | `INTERNALBEYOND` | `M1B_PAGE_*_CLASS_INTERNALBEYOND` |
| WebView JS href class | `CUSTOM` | fixed `hrefClass` result |
| WebView origin class | `OPAQUE` | fixed `originClass` result |
| WebView pathname class | `ROOT` | fixed `pathnameClass` result |

The exact raw custom scheme is intentionally not emitted by the acceptance probe. The evidence proves that the JS execution context is not presenting the Host's HTTP/InternalBeyond identity as a normal `http(s)` URL. It does not prove `tauri://`, `asset://`, `about:blank`, or a specific other scheme.

## E. Origin Analysis

The actual bounded WebView values were `origin=null` and `pathname=/`. The Host marker was present, but `IB.host` was absent and `#nav-home` was absent. Therefore the marker alone cannot establish that the Web Core document is loaded.

This is not a CORS failure: the same server accepted the M3 POST with the matching runId. It is an identity/context mismatch between the Host PageLoad payload and the JavaScript execution context used by `webview.eval`/initialization lifecycle.

## F. Runtime Marker

`assets/js/host-capability.js:54-64` recognizes the existing marker, Tauri globals, WebView2 and canonical Tauri origin. The fixed Host marker is set by `src-tauri/src/lib.rs:869-876`.

Observed:

```text
ibMarkerPresent = true
ibHostPresent    = false
platform         = not reported as tauri
```

No mock, platform override, `window.IB` replacement or hardcoded `tauri=true` was used.

## G. Resource Loading

P7 independently proves the installed static server serves `InternalBeyond.html`, assets, runtime and services from the isolated install root, with no repository escape. The WebView identity probe, however, did not observe `#nav-home` or `IB.host` in its JS context, so it cannot claim that the WebView context loaded those Web Core resources.

Repository escape = **none** for the installed Host/service root. WebView resource-context proof = **DEGRADED**.

## H. Identity Mismatch Root Cause

The mismatch is now precise:

```text
Host PageLoad payload: HTTP + InternalBeyond.html
WebView JS context:   CUSTOM + OPAQUE + /
Web Core evidence:    body/title present, marker present, IB.host absent, navHome absent
```

The evidence does not distinguish between a custom-protocol/opaque main frame and a different WebView execution context/frame. It therefore cannot safely claim that the actual Web Core page is loaded, nor can it safely redesign Host loading to compensate. This is the W3D stop boundary.

## I. Finished Event Idempotency

The lifecycle records repeated Finished events with the same `documentSeq=1`. The current fixed source guard and Host scheduling did not produce a reliable one-probe-per-document guarantee: multiple `M1B_DOCUMENT_PROBE_EXECUTED_DOC1` events were observed.

The result endpoint now prevents lower-phase bootstrap messages from overwriting M3 (`services/internal-beyond-server.js:456-492`), but document-probe idempotency itself remains **DEGRADED**.

## J. Security Boundary

The identity probe is compiled and fixed. It reads only bounded classifications and booleans. No arbitrary eval input, native invoke, shell, filesystem, storage, registry, cookie, credential, WebSocket, named pipe, DevTools or new Tauri capability was added.

## K. Production Invariance

The run used the test-only installer/AppId and existing isolated P7 harness. Production `dist` hashes, `VERSION`, registries, shortcuts, roots and user data remained unchanged. P32-W.2 remains frozen.

## L. Remaining

M3 is bounded and partially useful, but canonical WebView JS identity, real `IB.host`, Web Core resource presence and `#nav-home` remain unproven. Continuing would require a supported Host/WebView loading or frame-observation change beyond this acceptance seam, or a new observation capability. W3A must remain paused.

## Closure Gate

| Gate | Result |
|---|---|
| WebView context identity proven | FAIL |
| Host/WebView mismatch explained | PARTIAL; exact custom scheme/frame unresolved |
| actual scheme classified | PASS as `CUSTOM/OPAQUE`; exact raw scheme intentionally not exposed |
| Host scheme/class | PASS: `HTTP + INTERNALBEYOND` |
| WebView origin/path | PASS as bounded evidence: `null + /` |
| `IB.host` real state | PASS as observed absent/false |
| `#nav-home` real state | PASS as observed absent/false |
| repeated Finished idempotency | DEGRADED |
| fixed sleep | PASS, none |
| no arbitrary eval/invoke | PASS |
| Secret Route modified | NO |
| P31 modified | NO |
| production invariant | PASS |

**P32-W.3D = DEGRADED.**
