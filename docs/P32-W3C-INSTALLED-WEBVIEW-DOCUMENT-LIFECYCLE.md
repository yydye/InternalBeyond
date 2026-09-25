# P32-W.3C · Installed WebView Document Lifecycle Convergence

审计日期：2026-09-22  
状态：**DEGRADED**

## A. Starting State

P32-W.3B proved the acceptance gate, fixed probe registration, `probe_started`, bounded loopback delivery, runId correlation, endpoint default-off, P7 lifecycle 43/43 and production invariance. M3/M4/M5 were still degraded.

This phase stayed within the acceptance seam. It did not modify Secret Route semantics, the seven-click threshold, P31, Terminal, installer authority, Stable Host Distribution, storage, Android, P33 or production Web Core.

## B. Lifecycle Audit

Canonical configuration: `src-tauri/tauri.conf.json:5-25` uses `frontendDist: "../.tauri-frontend"`, `withGlobalTauri`, and window URL `InternalBeyond.html?ib_tauri_host=1` with `create:false`.

Host creation: `src-tauri/src/lib.rs:947-975` manually creates the configured window with `WebviewWindowBuilder::from_config(...).initialization_script(init_script).build()`.

Wry/WebView2 behavior verified from the pinned local dependency source:

- initialization scripts are registered with WebView2 `AddScriptToExecuteOnDocumentCreated` and navigation follows afterward (`wry-0.55.1/src/webview2/mod.rs:492-495,517-535`);
- `ContentLoading` maps to Started and `NavigationCompleted` maps to Finished (`wry-0.55.1/src/webview2/mod.rs:642-670`);
- initialization script documentation states it runs when a new page loads before `window.onload` (`wry-0.55.1/src/lib.rs:950-968`).

Current Host acceptance lifecycle is `src-tauri/src/lib.rs:823-930`: it classifies page URLs, records bounded page events, marks the Host, and schedules the fixed Document Probe only for `INTERNALBEYOND` Finished events.

## C. Document Timeline

Final isolated W3C transport run evidence, with timestamps from the test-owned log:

| Seq | Host/WebView event | Document class | Evidence |
|---|---|---|---|
| bootstrap | initialization probe registered | `BOOTSTRAP` | `M1_BOOTSTRAP_PROBE_REGISTERED`, bootstrap result `probe_started` |
| 1 | PageLoad Started | `INTERNALBEYOND` | `M1B_PAGE_STARTED_DOC1_CLASS_INTERNALBEYOND` |
| 1 | PageLoad Finished | `INTERNALBEYOND` | `M1B_PAGE_FINISHED_DOC1_CLASS_INTERNALBEYOND` |
| 1 | document probe scheduled | `INTERNALBEYOND` | `M1B_DOCUMENT_PROBE_SCHEDULED_DOC1_CLASS_INTERNALBEYOND` |
| 1 | endpoint becomes ready | same runId/isolated port | `M2_SERVER_BOOT`, `M2_ENDPOINT_GET_FIRST` |
| 1 | document probe executed | `INTERNALBEYOND` | `M1B_DOCUMENT_PROBE_EXECUTED_DOC1` |
| 1 | bounded M3 result received | `INTERNALBEYOND` Host class | server `M2_PHASE_DOCUMENT_STATE` |
| 1 | repeated Finished | `INTERNALBEYOND` | a second `M1B_PAGE_FINISHED_DOC1...` occurred; it reused the Host sequence and caused a second fixed eval |

The bounded M3 result was:

```text
phase=document_state
documentSeq=1
urlClass=INTERNALBEYOND
pageLoadPhase=finished
ready=true
readyState=complete
origin=null
pathname=/
tauri=false
navHome=false
```

No `tauri_recognized` or `nav_home_found` result was accepted before the installed Host lifecycle ended.

## D. URL Classification

The acceptance-only classifier at `src-tauri/src/lib.rs:59-76` emits only:

`BLANK`, `OPAQUE`, `INTERNALBEYOND`, `OTHER_LOCAL`, `UNEXPECTED`.

The target PageLoad payload was classified `INTERNALBEYOND` from its bounded pathname. The WebView-side bounded state simultaneously exposed `origin=null` and `pathname=/`; those are retained as evidence and are not normalized into a passing Tauri identity.

## E. Initial Hypothesis

Hypothesis: the initialization probe runs in a transient/opaque context, reports M2, then a document replacement destroys that context before DOM milestones.

Conclusion: **PARTIALLY CONFIRMED**.

Confirmed:

- bootstrap initialization produced M2 before the static server was ready;
- target Host PageLoad Started/Finished events were later classified `INTERNALBEYOND`;
- the first document probe was scheduled before endpoint readiness and then executed after a bounded Host-side endpoint handoff;
- the resulting M3 came from `documentSeq=1` with opaque WebView state and no DOM target;
- repeated Finished events reused `documentSeq=1` and triggered additional fixed eval submissions.

Not proven:

- whether the opaque state is a blank document, a custom-scheme representation, or a WebView2 frame/context different from the PageLoad payload;
- whether the repeated Finished event represents a new top-level document or a duplicate navigation completion.

## F. Bootstrap Probe

`ACCEPTANCE_BOOTSTRAP_PROBE` at `src-tauri/src/lib.rs:85-136` is initialization-only in transport mode. It reports only bounded `probe_started`, with `documentSeq=0`, `urlClass=BOOTSTRAP`, and `pageLoadPhase=initialization`.

It does not query DOM, call product handlers, set `tauri=true`, or mock any runtime API.

## G. Page-load Handoff

`on_page_load` at `src-tauri/src/lib.rs:827-930` now:

1. classifies Started/Finished without logging a full URL;
2. increments/retains a bounded Host document sequence;
3. logs target PageLoad events;
4. schedules the fixed Document Probe only for `INTERNALBEYOND` Finished;
5. waits for the existing acceptance endpoint with a bounded Host-side TCP readiness loop (`:423-461`);
6. verifies the Host sequence is still current;
7. runs the fixed probe on the WebView main thread.

No fixed 5-second/10-second sleep is used. The only waits are bounded endpoint readiness and the probe's bounded DOM readiness polling.

## H. Target Document Identity

Host identity = `INTERNALBEYOND` from the PageLoad URL classification. The Document Probe carries `documentSeq`, `urlClass`, and `pageLoadPhase` in the bounded result (`src-tauri/src/lib.rs:138-236`).

The Host-side identity is proven. The WebView-side identity is only partially proven because `origin=null/pathname=/` and `#nav-home` was absent. The implementation does not downgrade that result to PASS.

## I. M3 Document State

M3 = **PASS for the bounded document-state milestone**, with a qualification: it proves a `Finished` event classified by Host as `INTERNALBEYOND` and a complete WebView document context, but the WebView origin/path representation is opaque and the expected DOM marker is absent.

The result channel retained M3 after the server phase monotonicity fix at `services/internal-beyond-server.js:456-492`, so later bootstrap `probe_started` messages could not overwrite a higher document phase.

## J. M4 Tauri Recognition

M4 = **FAIL/DEGRADED**. The bounded Document Probe reported `tauri=false`. No mock or hardcoded `tauri=true` was used. The fixed Host marker is set by the existing Host lifecycle, but the WebView-side `IB.host.platform()` was not observed as Tauri in the target probe context.

## K. M5 DOM Target

M5 = **FAIL/DEGRADED**. `document.querySelector('#nav-home')` was not observed in the target probe context. No click was attempted.

## L. Race Analysis

| Race | Result |
|---|---|
| A. Probe before endpoint | Fixed by bounded Host-side endpoint readiness and phase-monotonic result retention |
| B. Initialization probe before target navigation | Confirmed as bootstrap-before-target behavior; bootstrap is now separate from Document Probe |
| C. Finished before IB/DOM | Not closed; Document Probe reports M3 but M4/M5 remain false/unobserved |
| repeated Finished with same Host seq | Observed; fixed source guard is not sufficient to prove a unique Host sequence because repeated evals were accepted |

The remaining ambiguity is now explicit rather than hidden behind a no-result timeout.

## M. Idempotency

The fixed Document Probe has a per-WebView guard keyed by `documentSeq`. Host-side scheduling is bounded and input-free. The final evidence nevertheless showed more than one `DOCUMENT_PROBE_EXECUTED_DOC1` after repeated Finished events, so W3C idempotency is **not claimed PASS** for the installed lifecycle.

No DOM click, resolver dispatch, Terminal open, P31 mount, storage write or model call occurred in this phase.

## N. W3A Level-3 Rerun

Not executed. M4/M5 did not pass, so the W3A full probe was not resumed.

## O. Secret Route Installed Results

| Check | Result |
|---|---|
| 6-click negative | NOT RUN |
| timeout reset | NOT RUN |
| 7-click positive | NOT RUN |
| Hidden Console | NOT RUN |
| Beyond/Terminal | NOT RUN |
| Beyond close/return | NOT RUN |
| middlebrain/P31 | NOT RUN |
| P31 side effects | NOT RUN |
| P31 close/return | NOT RUN |
| malicious spot-check | NOT RUN in installed DOM; resolver/CDP matrix remains PASS |
| model calls | 0 from lifecycle probe; full W3A count not applicable |

## P. Security Boundary

Only fixed compiled acceptance scripts are used. No arbitrary eval input, HTTP `/eval`, CLI script, native invoke, shell, filesystem, storage, registry, WebSocket, named pipe, DevTools or additional automation channel was introduced. Endpoint remains bounded, runId-checked and default-OFF.

## Q. Lifecycle Regression

The final isolated run completed the existing P7 smoke with **43 passed, 0 failed, 0 skipped**. This proves install/upgrade/uninstall/single-instance/service/root invariants, not W3A DOM closure.

## R. Production Invariance

The build was test-only. Production `dist` hashes, root `VERSION`, production registry/shortcuts/roots and user data were not changed. P32-W.2 remains frozen.

## S. Cleanup

After final evidence, remove only the owned test installer/build root, isolated P7 roots/data, exact test shortcuts/registry residue, current runId logs and acceptance memory state. Preserve the parent `tmp` and all unrelated dirty worktree changes. Do not use image-name broad kills.

## T. Remaining

The target document lifecycle is now observable through Host URL classification and M3, but the WebView-side canonical Tauri identity and `#nav-home` DOM are absent/opaque. This crosses the W3C stop boundary: continuing would require a supported WebView/Host loading fix beyond the current acceptance-only probe, or a new observation capability.

## Closure Gate

| Gate | Result |
|---|---|
| actual document lifecycle timeline | PARTIAL PASS |
| blank/opaque hypothesis | PARTIALLY CONFIRMED |
| actual InternalBeyond Host document identified | PASS by Host URL class |
| deterministic Finished handoff | PARTIAL; repeated Finished same seq observed |
| fixed sleep used | PASS, none |
| M0 | PASS |
| M1 | PASS |
| M2 | PASS |
| M3 | PASS with opaque WebView qualification |
| M4 | DEGRADED / false |
| M5 | DEGRADED / false |
| M6 | PASS for received M3; full ladder not closed |
| no arbitrary eval/invoke | PASS |
| endpoint default-OFF | PASS |
| no high-risk capability | PASS |
| repository escape | PASS |

**P32-W.3C = DEGRADED.**

W3C proved the Host-side target lifecycle and produced a bounded M3 from the same isolated acceptance universe without timing sleep. It did not prove canonical Tauri identity or the installed `#nav-home` DOM, so W3A and W3 remain DEGRADED.

## U. P32-W.3D Identity Resolution

W3D added the bounded WebView identity fields and fixed Host scheme events. Final comparison:

```text
Host:    schemeClass=HTTP, urlClass=INTERNALBEYOND
WebView: hrefClass=CUSTOM, originClass=OPAQUE, pathnameClass=ROOT
         origin=null, pathname=/
         title/body=true, ibMarker=true, ibHost=false, navHome=false
```

This proves the mismatch is real and not a CORS/result-polling failure, but it does not identify a canonical Tauri WebView context or prove the installed Web Core DOM. Repeated Finished events still produce multiple document-probe executions for `documentSeq=1`; W3D remains DEGRADED and W3A remains paused.
