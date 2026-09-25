# P32-W.3B · Acceptance Probe Transport Diagnosis

审计日期：2026-09-22  
状态：**DEGRADED**

本轮只处理 P32-W.3A 的 installed WebView acceptance transport。P32-W.2、Installer authority、Stable Host Distribution、Secret Route semantics、P31、Terminal、Android、storage migration 和 P33 均保持冻结。

## A. Starting State

P32-W.3 与 P32-W.3A 在本轮开始时都是 DEGRADED。Browser/CDP resolver、legacy handler reuse、Host lifecycle、isolated installer smoke 和 production invariance 已通过；未闭合项是 installed Tauri WebView 的真实 DOM acceptance result 没有形成 bounded result。

Phase 0 只读审计覆盖：

- `src-tauri/src/lib.rs:24-39,50-306,676-704,721-743`；
- `services/internal-beyond-server.js:351-479`；
- `tests/test_secret_routes_acceptance_contract.js`；
- `tests/test_secret_routes_host_cdp.js`；
- `tests/test_installer_smoke.js:477-489,763-769`；
- `tests/test_secret_routes_installed_probe.js:26-168`；
- `docs/P32-W2-TAURI-HOST-INTEGRATION.md`、`docs/P32-W2A-INSTALLER-SMOKE-ISOLATION.md`、`docs/P32-W2B-RUNTIME-PAYLOAD-CLOSURE.md`、`docs/P32-W3-SECRET-ROUTE-BRIDGE.md`、`docs/P32-W3A-INSTALLED-WEBVIEW-DOM-ACCEPTANCE.md`。

## B. Transport Architecture

当前 acceptance universe 是：

```text
test wrapper
  -> P7 real-install-smoke with isolated ports/root/AppId
  -> installed internalbeyond-host.exe
  -> existing launcher and loopback static server
  -> Tauri WebView initialization/page-load fixed probe
  -> bounded POST /__p32-w3a/acceptance
  -> same loopback server memory result
  -> wrapper polling the same isolated port
```

Gate：`IB_ACCEPTANCE_SECRET_ROUTES=1`。关联值：`IB_ACCEPTANCE_SECRET_ROUTES_RUN_ID`。Probe source is compiled into Rust; no request-supplied JavaScript is accepted.

## C. Timeline

实际合法顺序与 race：

```text
T0 wrapper generates runId and sets acceptance env
T1 P7 smoke receives the environment and launches installed Host
T2 Host reads the gate while constructing the fixed probe
T3 Host starts the existing launcher and propagates the gate/runId
T4 existing launcher starts the static server on the isolated IB_WEB_PORT
T5 Tauri WebviewWindowBuilder creates the configured main WebView
T6 fixed marker/probe is registered through initialization and page-load seams
T7 WebView navigation emits Finished callbacks for InternalBeyond.html
T8 probe starts and posts probe_started after bounded endpoint readiness
T9 endpoint accepts the bounded result with the matching runId
T10 wrapper polls the same isolated port
```

The first implementation also allowed T8 before T4. That could block the first report on a not-yet-listening loopback port. The probe now uses bounded readiness/abort and the harness waits boundedly for endpoint arming. A second race remains: WebView navigation/document replacement can occur after the fixed script is registered, before a stable DOM milestone is returned.

## D. Environment Propagation

Evidence:

- `tests/test_secret_routes_installed_probe.js:88-95` sets the acceptance gate, runId and transport mode for the P7 child.
- `tests/test_installer_smoke.js:480-489` carries the parent environment into the isolated child environment.
- `tests/test_installer_smoke.js:763-769` passes that environment to the installed Host executable.
- `src-tauri/src/lib.rs:287-305` reads the gate, isolated `IB_WEB_PORT`, and validated runId before constructing the source-fixed probe.
- `src-tauri/src/lib.rs:552-575` starts the existing launcher and now passes both `IB_ACCEPTANCE_SECRET_ROUTES` and `IB_ACCEPTANCE_SECRET_ROUTES_RUN_ID`.
- `services/internal-beyond-server.js:362-364` reads the same gate/runId in the existing static server.

结论：env 到 installed Host = **PASS**。本轮发现并修复了 Host → launcher 缺失 runId 的传播断点；这不是 production launcher contract 的改变，只有显式 acceptance gate 时才发生。

## E. Host Gate

Host diagnostic is memory-free, test-owned and fixed-event-only at `src-tauri/src/lib.rs:32-43`.

`M0_GATE_DETECTED` appeared in the final isolated run. No gate value, secret, DOM, user data or arbitrary input is logged.

结论：M0 HOST_GATE = **PASS**。

## F. Probe Injection

The probe is source-fixed in `src-tauri/src/lib.rs:50-137` (transport ladder) and `:143-285` (W.3A full probe). Selection is a fixed two-value mode at `:300-302`; unrecognized mode falls back to the existing full probe.

Supported seams used:

- fixed Host marker through `initialization_script` at `src-tauri/src/lib.rs:734-743`;
- transport probe registration through the same initialization script under the explicit `transport` test mode at `src-tauri/src/lib.rs:735-741`;
- fixed page-load `webview.eval` at `src-tauri/src/lib.rs:676-704`.

`M1_PROBE_REGISTERED`, `M1_INIT_PROBE_REGISTERED`, `M1B_PAGE_LOAD_CALLBACK`, `M1B_PAGE_URL_INTERNAL`, and `M1B_PROBE_EVAL_OK` appeared in the final test-owned log.

结论：M1 PROBE_INJECTED = **PASS**。The source is fixed; no arbitrary eval/invoke surface was added.

## G. Probe Execution

The transport probe contains only bounded readiness, document state, Tauri recognition, and `#nav-home` observation. It does not click, open Console, submit aliases, call `IB.secretRoutes`, call `IB.easterEgg`, call P31, send a model message, read storage, or dump DOM.

`M2_PHASE_PROBE_STARTED` and `M2_BODY_ACCEPTED` were written by the same static server. This proves that WebView-side JavaScript executed far enough to deliver the first milestone.

The final run did not deliver `document_state`, `tauri_recognized`, or `nav_home_found` from a stable installed DOM context. Earlier diagnostic runs returned a bounded `readyState=complete`, `origin=null`, `pathname=/`, `tauri=false`, `navHome=false` snapshot; because that snapshot was not the expected document identity, it is treated as diagnostic evidence, not an installed DOM PASS.

结论：M2 PROBE_STARTED = **PASS**; stable M3–M5 execution = **DEGRADED**。

## H. Result Endpoint

The endpoint is registered in the existing static server at `services/internal-beyond-server.js:388-479`. It is:

- absent by default;
- loopback-only;
- origin-guarded;
- POST-body bounded to 32 KiB;
- phase allowlisted;
- boolean/string/number fields bounded;
- memory-only and process-lifetime scoped;
- terminal-result protected after `done=true`.

The server records fixed transport events at `services/internal-beyond-server.js:363-372,405-407,418-474`. The final isolated run showed `M2_SERVER_BOOT`, `M2_ENDPOINT_GET_FIRST`, `M2_ENDPOINT_POST_RECEIVED`, `M2_PHASE_PROBE_STARTED`, and `M2_BODY_ACCEPTED`.

结论：the endpoint receives the bounded `probe_started` result = **PASS**; full milestone result = **DEGRADED**。

## I. Run Identity

RunId is generated per wrapper run at `tests/test_secret_routes_installed_probe.js:23-24`, validated by Rust at `src-tauri/src/lib.rs:24-30`, propagated to the launcher at `:570-575`, and matched by the endpoint at `services/internal-beyond-server.js:448-453`.

The final evidence showed the same ephemeral runId in Host events and server events. No runId is persisted to disk after wrapper cleanup, and it is not a production session/user/chat identifier.

结论：Host/WebView/server/harness correlation for the received M2 result = **PASS**。

## J. Endpoint Instance Proof

The wrapper extracts the dynamic isolated Web port from P7 output at `tests/test_secret_routes_installed_probe.js:101-104`, waits for the endpoint at `:50-61,116-118`, and polls that same `127.0.0.1:<port>/__p32-w3a/acceptance` at `:31-49`.

P7 proves the install root and service root are isolated; `tests/test_secret_routes_installed_probe.js:132-135` also checks the boot-state root and installed Host presence when a terminal result exists. The server and Host diagnostic entries share the same runId and isolated port.

结论：no evidence of polling a production `23120` server or a second Web Core. Endpoint instance proof = **PASS for the received M2 result**。

## K. Origin / CORS / CSP

The POST path used `mode:'cors'`, a simple `text/plain` content type, `credentials:'omit'`, bounded abort, and no custom non-safelisted header (`src-tauri/src/lib.rs:72-98`). The endpoint returns CORS only for the existing accepted local/Tauri origins (`services/internal-beyond-server.js:392-407`).

Observed evidence:

- no `M2_ORIGIN_DENIED` event;
- POST received and accepted by the endpoint;
- no preflight/error surface was needed for the accepted M2 report;
- the earlier `no-cors` + custom-header fallback was removed because it could be rejected before network delivery.

The opaque `origin=null`/`pathname=/` snapshot came from the unstable WebView execution context and is not treated as a CORS success or a valid installed-document identity. It is a remaining WebView lifecycle/identity issue, not an endpoint CORS failure.

## L. Milestone Results

| Milestone | Evidence | Result |
|---|---|---|
| M0 HOST_GATE | Host fixed diagnostic `M0_GATE_DETECTED` | PASS |
| M1 PROBE_INJECTED | `M1_PROBE_REGISTERED`, init registration, page-load eval accepted | PASS |
| M2 PROBE_STARTED | same server accepted `M2_PHASE_PROBE_STARTED` | PASS |
| M3 DOCUMENT_STATE | no trustworthy installed-document result; blank/opaque diagnostic only | DEGRADED |
| M4 TAURI_RECOGNIZED | no trustworthy actual-DOM result | DEGRADED |
| M5 NAV_HOME_FOUND | no trustworthy actual-DOM result | DEGRADED |
| M6 RESULT_CHANNEL_CONFIRMED | bounded `probe_started` result and matching runId received | PASS for M2 only |

W3B therefore does not satisfy the all-M0–M6 closure gate.

## M. Root Cause

There were three transport/lifecycle defects, two of which are fixed:

1. Host started the launcher with the acceptance gate but not the acceptance runId. The endpoint consequently rejected result bodies as a run mismatch. Fixed at `src-tauri/src/lib.rs:570-575`.
2. The first report could occur before the static server listened. The probe now has bounded endpoint readiness/abort, and the harness waits boundedly for endpoint arming.
3. The current installed WebView lifecycle can register the fixed probe while the document is still being replaced/initialized. Host payload events classify the target as `InternalBeyond.html`, but the probe does not reach a stable DOM result containing `#nav-home`; the only returned diagnostic snapshot was opaque/blank-shaped. Proving/fixing that would require a broader Host/WebView loading or observation change, or a new automation channel, which is outside W3B's safe scope.

## N. Minimal Fix

Implemented within acceptance seam only:

- explicit runId propagation to the existing launcher;
- bounded endpoint readiness and abortable POST delivery;
- simple CORS-safe `text/plain` POST;
- transport-only source-fixed milestone probe;
- fixed Host transport log events;
- endpoint phase/runId/schema bounds and terminal-result retention;
- bounded harness endpoint wait and same-port polling;
- initialization/page-load registration diagnostics.

Not implemented:

- no Secret Route product semantic change in W3B;
- no 7-click threshold change;
- no arbitrary eval/invoke;
- no WebView2 DevTools, Playwright, WebSocket, named pipe, second server, UI Automation, shell or filesystem capability;
- no installer, production Host distribution, storage, registry, Android or P33 change.

## O. W.3A Level-3 Rerun

Not run to completion after the transport gate because M3–M5 did not pass. The `--full-dom` mode exists in the same acceptance wrapper, but it was intentionally not used to claim W3A closure before the W3B gate was proven.

Earlier W.3A attempts remain DEGRADED: no bounded full DOM result was received. Browser/CDP and checkout Host evidence are not substituted for installed WebView DOM evidence.

## P. Lifecycle Regression

The final test-only installed run completed the existing P7 real smoke with **43 passed, 0 failed, 0 skipped**. This covered isolated install, installed-root binding, Host visibility/responding, single-instance focus, five service surfaces, running upgrade, runtime replacement, unrelated Node survival, user-data preservation, uninstall, and developer-instance invariance.

This is lifecycle evidence only; it does not close the installed DOM acceptance.

## Q. Security Invariance

The result endpoint remains default-OFF. The fixed probe accepts no script input. The endpoint accepts only the fixed phase enum and bounded schema. No credentials, DOM dump, arbitrary URL, command, shell, native invoke, model message, storage value, or registry value is transported.

## R. Production Invariance

The W3B build used `scripts/build-installer.ps1 -TestMode` and the protected test AppId. Production `dist/InternalBeyond-Setup-1.0.6.exe`, `dist/SHA256SUMS.txt`, `dist/update-stable.json`, `VERSION`, production registry/shortcuts/install roots and user data were not modified. Production hashes were rechecked after the final test-only run.

## S. Cleanup

P7 removed its owned temporary install/data roots, test AppId entries and shortcuts. The wrapper removed the current runId transport log. The remaining `tmp/installer-smoke-build` directory is an exact test-only build root and is removed as the final cleanup step; the parent `tmp` directory and unrelated worktree contents are preserved.

No broad process-name kill was used.

## T. Remaining

The remaining blocker is a supported, stable observation point for the actual installed Tauri WebView document. The current evidence proves fixed probe registration and bounded result delivery, but not that the probe can observe the installed `#nav-home` DOM in a stable document context.

Do not proceed to P33, Android, storage migration, Jev/Decision Plane, or a new automation channel from this report. A future continuation must first choose a narrowly scoped supported Host/WebView loading observation fix or explicitly accept W3A as an external acceptance blocker.

## Closure Gate

| Gate | Result |
|---|---|
| M0 Host gate | PASS |
| M1 fixed probe injection | PASS |
| M2 probe started | PASS |
| M3 document state from stable installed document | DEGRADED |
| M4 Tauri recognition from stable installed document | DEGRADED |
| M5 `#nav-home` found from stable installed document | DEGRADED |
| M6 bounded result/runId correlation | PASS for M2; not full ladder |
| no arbitrary eval/invoke | PASS |
| endpoint default-OFF | PASS |
| no production capability expansion | PASS |
| no repository escape / production root | PASS |

**P32-W.3B = DEGRADED.**

The acceptance transport is partially proven end-to-end through Host gate, fixed probe registration, WebView `probe_started`, bounded loopback delivery, same runId and same isolated server. The stable installed document milestone ladder is not proven, so W.3A and W.3 remain DEGRADED.

## U. P32-W.3C Lifecycle Follow-up

W3C added bounded Host document sequence and URL-class diagnostics, separated bootstrap M2 from the target-document probe, gated the Document Probe on `INTERNALBEYOND` Finished, and waited for the existing acceptance endpoint through a bounded Host-side readiness check. The final run proved `documentSeq=1`, Host `INTERNALBEYOND` Started/Finished, and bounded M3:

```text
readyState=complete
origin=null
pathname=/
urlClass=INTERNALBEYOND
tauri=false
navHome=false
```

This changes the W3B diagnosis from “no stable document result” to “Host target lifecycle and M3 are proven, but WebView-side Tauri identity/DOM are still not proven.” M4/M5 remain DEGRADED. W3B is not promoted to CLOSED because W3A full Level-3 was intentionally not resumed.

## V. P32-W.3D Identity Evidence

The final bounded identity result classified the Host payload as `HTTP + INTERNALBEYOND`, while the WebView context was `CUSTOM + OPAQUE + ROOT` with `origin=null`, `pathname=/`, `ibMarker=true`, `ibHost=false`, and `navHome=false`. The W3D report records this mismatch and stops before W3A.
