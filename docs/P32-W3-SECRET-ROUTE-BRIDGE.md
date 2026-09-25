# P32-W.3 · Secret Route Bridge

审计日期：2026-09-22  
状态：DEGRADED（Browser bridge、resolver、旧 handler 与 Host lifecycle 通过；installed Host 的 DOM gesture 未能在当前 WebView2 acceptance surface 复现）

## A. Starting State

P32-W.2 remains frozen: Existing Inno is the production installer, root `VERSION` is authoritative, the stable Host is `internalbeyond-host.exe`, and the installed Web Core remains one tree. This phase did not modify installer authority, production `dist`, storage schema, credentials, or Android/P33 work.

Phase 0 was read-only before implementation. The canonical documents read were:

- `docs/P32-W2-TAURI-HOST-INTEGRATION.md`
- `docs/P31_MIDDLE_BRAIN_DIRECT_CHANNEL.md`
- `docs/P32-2-TAURI-HOST-FOUNDATION.md`
- `docs/P32-W-WINDOWS-TAURI-PRODUCTIZATION.md`

## B. Legacy Route Audit

| Finding | Evidence |
|---|---|
| Terminal trigger | `assets/js/easteregg.js:15`, `154-166`: keyboard buffer recognizes `beyond` case-insensitively within a 1200 ms gap; `:140-152` opens/closes the existing overlay. `:182-183` exports `IB.easterEgg`. |
| `#Beyond` trigger | `assets/js/easteregg.js:168-179`: the existing handler tests `/beyond/i` against the complete `location.hash`, runs on DOM ready and `hashchange`, and opens the same Terminal. The broad substring behavior is intentionally preserved. |
| P31 parser | `assets/js/middle-brain-direct.js:792-804`: `URLSearchParams` accepts key `middlebrain` with value empty, `1`, or `true`; `0` is not accepted. |
| P31 close/return | `assets/js/middle-brain-direct.js:806-815,865-872`: close removes only the direct query with `replaceState`, retaining other query parameters and the existing hash. |
| P31 lifecycle | `assets/js/middle-brain-direct.js:874-963`: dynamic overlay `#ib-middle-brain-direct-root`; no `navTo`, no normal `page-*`, query/hash synchronization, and close/escape cleanup. |
| Basement | `assets/js/basement.js:33-62,102-128,130-148`: Room bookshelf marker → three-digit lock → exact code `666` → stairs. It is a UI-only easter egg, not an address-bar route. |
| Basement persistence/return | `assets/js/basement.js:19,29-30,165-195,205-210`: `localStorage['ib_basement_v2']` preserves crack/discovered/mode; the existing return control and Escape remove `infernal-beyond` mode. |
| Existing unified resolver | No pre-existing secret-route resolver or common route dispatch seam was found. `navTo()` in `assets/js/core.js:389-488` is the ordinary page/hash router and is not a secret-route resolver. |

## C. Route Inventory

Stable route IDs are not URL strings. URL/hash forms are adapter inputs.

| Route ID | Legacy trigger | Parser | Handler | Side effects | Close/return |
|---|---|---|---|---|---|
| `beyond` | `#Beyond` / `#beyond` and the legacy `/beyond/i` hash behavior; keyboard `beyond`; DevTools `IB.easterEgg.open()` | Browser `assets/js/secret-routes.js:67-93`; keyboard delegates from `assets/js/easteregg.js:154-169` | Existing `IB.easterEgg.open()` / `assets/js/easteregg.js:140-152` | Existing Terminal DOM overlay only; no model, network, storage, shell, or native invoke | Existing `IB.easterEgg.close()` hides the overlay and preserves the hash exactly, including the legacy reopen-on-refresh behavior |
| `middlebrain` | `?middlebrain`, `?middlebrain=1`, `?middlebrain=true`; console aliases `middlebrain`, `?middlebrain`, `?middlebrain=1`, `?middlebrain=true` | Existing P31 parser plus Browser adapter `assets/js/secret-routes.js:67-117` | Existing `IB.middleBrainDirect.mount()` / `assets/js/middle-brain-direct.js:874-943` | Existing independent Direct transcript and bounded read-only context; resolver itself does no model call | Existing P31 close `replaceState` preserves previous page/hash and removes only `middlebrain` |
| `basement` (audited UI easter egg, not bridge-dispatchable) | Room bookshelf marker → password `666` → stairs | `assets/js/basement.js:58-62,102-123` | Existing `openBasement()` / `activateBeyond()` | Existing `ib_basement_v2` memory-only-to-the-module localStorage contract | Existing `returnToSurface()` / Escape; no URL/query adapter was added |

## D. Canonical Resolver

New resolver: `assets/js/secret-routes.js`.

It exposes `IB.secretRoutes` through the existing `IB.expose` namespace and implements:

- `resolve(input, context)` → `{ matched, routeId, normalizedInput, source, action }`;
- `dispatch(routeId, options)` with a hard route-ID allowlist;
- `handleBrowser(location)` for query/hash lifecycle;
- `openConsole()` / `closeConsole()` for the Tauri-only hidden adapter.

The resolver only passes bounded navigation metadata (`triggerSource`, optional previous page/hash/query) to existing handlers. It never accepts arbitrary JS, URL, path, shell command, protocol, or native command input.

## E. Browser Adapter

`assets/js/secret-routes.js:330-338` owns `DOMContentLoaded`, `hashchange`, and `popstate` Browser lifecycle. It dispatches `middlebrain` before `beyond` when both legacy inputs coexist, while preserving both existing handlers. `InternalBeyond.html:3303-3305` loads the resolver before Basement/Terminal, and `:3464` keeps P31 after Home Node bootstrap.

Browser checks passed:

- normal page has no secret UI;
- `?middlebrain`, `?middlebrain=1`, and `?middlebrain=true` mount P31;
- `?middlebrain=0` remains hidden;
- `#Beyond` and hashchange open the existing Terminal;
- P31 close removes only its query and preserves `#chat`;
- Beyond close preserves `#Beyond` exactly.

## F. Tauri Hidden Trigger

The existing `#nav-home` logo is the hidden trigger element; no visible button, sidebar item, or Settings route was added. `assets/js/secret-routes.js:301-320` requires seven clicks within 1800 ms, resets on timeout/hashchange, and stores the count only in closure memory.

Tauri recognition remains behind `IB.host` / `assets/js/host-capability.js:54-63,224-229`. The host seam recognizes the existing Tauri globals/origin/WebView2 runtime markers dynamically; native Project Knowledge commands still require the existing `core.invoke` function.

## G. Hidden Console

The console is generated only by `assets/js/secret-routes.js:225-279` and uses scoped CSS appended to `assets/css/core/middle-brain-direct.css:31-97`. It has:

- `Esc` and close-button dismissal;
- focus entering the input and returning to the logo on close;
- no URL navigation, shell, filesystem, native invoke, or model call;
- exact unknown-route text: `Unknown secret route.`;
- visual-only `internalbeyond://` prefix; users enter aliases, not real URLs.

Allowlisted aliases are defined at `assets/js/secret-routes.js:23-30`: `Beyond`, `#Beyond`, `middlebrain`, `?middlebrain`, `?middlebrain=1`, and `?middlebrain=true` (case-normalized for console input).

## H. Security Boundary

`resolve()` is pure. Unit tests prove zero handler calls during resolve and reject:

`javascript:alert(1)`, `file:///C:/Windows/System32`, `https://example.com`, `http://127.0.0.1`, `cmd.exe`, `powershell`, traversal paths, `internalbeyond://../../foo`, markup/script input, and fuzzy `midlebran`.

The resolver source contains no `eval`, `fetch`, `XMLHttpRequest`, storage access, filesystem access, child-process API, or native invoke call. Console dispatch only selects the two allowlisted existing handlers.

## I. P31 Integration

No P31 prompt, transcript authority, context resolver, provider seam, timeout, Project Knowledge adapter, character, thread, relationship, activity, memory, or world writer was changed. `middleBrainDirect.mount({force:true})` is the only small trigger seam added so the Tauri console can enter the existing overlay without fabricating `?middlebrain`.

The P31 contract remains `directChatSystemPrompt` → bounded read-only resolver → `IB.middleBrainDirectModelCall` → canonical Astra seam. P31 Node contract passed.

## J. Beyond Integration

Browser hash and Browser keyboard triggers delegate to the same `IB.easterEgg.open()` handler used by the Tauri console. The Terminal UI, animation, copy, close behavior, and hash persistence were not refactored.

## K. Close / Return Semantics

`#chat → console → middlebrain → P31 close` returns to `#chat` in Browser/CDP and in the Tauri test-double path. Beyond close preserves the current legacy hash. The Basement return path remains its own pre-existing mode reset.

## L. Browser Regression

Passing commands/evidence:

```text
node tests/test_secret_routes.js
node tests/test_secret_routes_cdp.js
node tests/test_easteregg.js
node tests/test_basement_cdp.js
node tests/test_middle_brain_direct.js
node tests/test_project_knowledge.js
node scripts/scripts_check_html.js InternalBeyond.html
```

`tests/test_secret_routes_cdp.js` passed 18 checks including normal Browser, all confirmed P31 query variants, false query, `#Beyond`, hash preservation, simulated Tauri console, unknown/malicious rejection, and handler reuse.

## M. Packaged Host Acceptance

The final acceptance-only build was test-only and never wrote `dist`:

```text
test installer: tmp/installer-smoke-build/InternalBeyond-Installer-Smoke-Test-Setup-1.0.6.exe
installer SHA-256:  56cc8c7787afa3db613159f33167e5d0a3a2fd7bf087acf9f92d4ab0890b3acd
stable Host PE:    1.0.6, 9,086,464 bytes, sha256 00fc889bbd4423466eef183b5b82af41d839cb528617694971555169178ef908
```

P7 installed payload audit passed 22/22. Real Host lifecycle smoke passed 43/43: visible/responding window, second-launch focus, no browser, installed-root binding, five service surfaces, upgrade/unlock, unrelated Node survival, user-data preservation, uninstall, and production invariance.

The installed Host WebView2 surface did not expose a usable DevTools target and the manual installed-payload window probe did not reproduce the hidden console gesture. The checkout Host visual probe did open the console and the existing Terminal/P31 surfaces, but this is not substituted for installed-payload DOM proof. Therefore this item remains DEGRADED.

## N. Negative / Malicious Input Tests

Resolver unit and CDP tests rejected protocol, URL, shell, traversal, markup/script, and fuzzy-route inputs without navigation or handler dispatch. Unknown input remains visible in the console instead of disappearing as a toast.

## O. Side-effect Audit

`resolve()` has zero model/network/storage/filesystem/native effects. `dispatch()` only calls the existing Terminal or P31 mount handler. The console itself performs no provider request and cannot create a route outside the allowlist.

## P. Production Invariance

No installer source, build script, Host staging script, stop helper, production shortcut, WebView2 install policy, or production `dist` artifact was changed by this phase. Final read-only hashes remained:

```text
dist/InternalBeyond-Setup-1.0.6.exe  52608553  ffcf9e6a729d97383c5e36c51c80e2dadac3efedafe6f854d1a5c0d65c14eb5c
dist/SHA256SUMS.txt                  406       0dfde9eff3e8545d9ef6a1509aed930de07da5a299988ada162d7517fb90e265
dist/update-stable.json              619       bdddf80ddd1d063e43d4a3a49f0797899853e15324f8acb207d0072ebe97c42c
VERSION                              6         51c18dc8694861beb47a67894e61044864214435389f6d3a274704d9566ff96c
```

## Q. Remaining

1. Installed Host WebView2 DOM gesture/console interaction needs a supported automation surface or a fresh Host acceptance harness that can observe the WebView DOM. The current environment did not expose the attempted remote-debugging target.
2. P32-W.2's existing full packaged DOM matrix, live Astra credentials, Browser/Tauri storage split, signing/updater, and fresh-WebView2 simulation remain unchanged degraded/out-of-scope items.

## Closure Gate

| Gate | Result |
|---|---|
| Existing routes audited / stable route IDs | PASS |
| Browser legacy triggers and close/return | PASS |
| One canonical resolver / existing handler reuse | PASS |
| No duplicate Middle Brain/Beyond | PASS |
| Allowlist and malicious rejection | PASS |
| Resolver zero side effects | PASS |
| Browser fallback | PASS |
| Host normal launch / lifecycle / single instance / installer invariance | PASS |
| Installed Host Hidden Console gesture DOM acceptance | DEGRADED |
| Installer changes / storage migration / new high-risk capability | NONE |

P32-W.3 = DEGRADED.

The Browser URL/hash triggers and the Tauri Hidden Console converge through one canonical Secret Route Resolver in the tested Web Core paths. Existing secret-route implementations are reused without duplication, and P31 plus the existing easter eggs retain their authority and semantics. P32-W.2 installer/Host closure remains frozen and intact.

## R. P32-W.3B Transport Update

The W.3B follow-up proved Host gate, fixed probe registration, `probe_started` delivery, bounded loopback acceptance, same isolated server/runId correlation, default-OFF behavior, and the existing P7 lifecycle smoke. It also fixed the acceptance-only launcher runId propagation and bounded endpoint-start race.

The installed WebView still does not provide a trustworthy stable DOM milestone result for `document_state`, Tauri recognition, and `#nav-home`. W.3A's real installed DOM gesture therefore remains DEGRADED, and this document intentionally does not promote P32-W.3 to CLOSED.

## S. P32-W.3C Lifecycle Update

The W3C follow-up proved the Host-side target document lifecycle and bounded M3 without fixed sleep: `documentSeq=1`, Host URL class `INTERNALBEYOND`, Started/Finished and `readyState=complete` were observed. The installed WebView result still reported opaque `origin=null/pathname=/`, `tauri=false`, and `navHome=false`; W3C therefore remains DEGRADED and W3A was not resumed.

## T. P32-W.3D Identity Resolution

The bounded identity probe refined the mismatch: Host PageLoad was `HTTP + INTERNALBEYOND`, while WebView JS was `CUSTOM + OPAQUE + ROOT`, with `title/body` and the Host marker present but `IB.host` and `#nav-home` absent. W3D remains DEGRADED; no Secret Route, P31 or Terminal semantics were changed.
