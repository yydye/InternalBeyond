# P32-W.3A · Installed WebView DOM Acceptance

审计日期：2026-09-22  
结论：**DEGRADED**

## A. Starting Blocker

P32-W.3 已证明 Browser URL/hash、resolver、existing Terminal、existing P31、negative inputs、zero-side-effect resolver、Host lifecycle、single instance、installer audit、upgrade/uninstall 和 production invariance。

唯一未闭合 gate 是：在 **isolated installed Existing Inno payload** 中观察真实 WebView DOM 的 `#nav-home → 7 clicks → Hidden Console`，并继续以真实 console input 驱动 `Beyond` 与 `middlebrain`。

## B. Existing Automation Audit

只读审计确认：

- `src-tauri/src/lib.rs:379-430` 创建 Tauri Host、管理 lifecycle、启动现有 launcher；没有独立 Browser/Playwright driver。
- `src-tauri/tauri.conf.json:5-25` 指定 `.tauri-frontend`、`withGlobalTauri`、main window、WebView URL 和 current-user window。
- `src-tauri/capabilities/default.json:1-7` 只有 `core:default` 与 `window-state:default`。
- `tests/test_secret_routes_cdp.js` 是 Chromium CDP/file-Web Core probe；它不是 installed Host DOM evidence。
- `tests/test_secret_routes_host_cdp.js` 尝试 acceptance-only `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 动态端口，但实际 WebView2 command line 没有出现该参数，`/json/list` 没有 target。

## C. Installed WebView Architecture

Installed acceptance 仍由：

```text
Existing Inno test AppId
  -> isolated install root
  -> internalbeyond-host.exe
  -> Tauri main WebView
  -> existing launcher / Web Core / local services
```

P7 smoke 证明 installed executable、Web Core、runtime、services、Bridge、Active、Home Node 和 boot-state 都绑定到 isolated root；real lifecycle smoke 通过 43/43。

## D. Acceptance Strategy

按优先级审计了 existing WebView/Tauri surface 与 remote-debugging。由于两者都无法提供稳定 installed DOM target，本轮建立了窄的 acceptance-only seam：

- explicit env gate：`IB_ACCEPTANCE_SECRET_ROUTES=1`；
- Rust source-fixed probe：`src-tauri/src/lib.rs:23-159`；
- fixed result channel：existing loopback static server `services/internal-beyond-server.js` 的 `/__p32-w3a/acceptance`；
- no arbitrary JS input, no arbitrary command, no DOM dump, no credential/result persistence。

`tests/test_secret_routes_acceptance_contract.js` 证明 endpoint 默认 404，显式 gate 后只接收 bounded result shape。

## E. Security Boundary

The probe is compiled source, not a request-supplied script. It can only wait for the existing DOM, click `#nav-home`, interact with the existing allowlisted Console form, close existing Terminal/P31 UI, and report bounded booleans plus origin/pathname. It cannot receive or execute user JavaScript, call arbitrary Tauri commands, access shell/filesystem, read storage, or send a model message.

## F. Test-only Activation

Production default is OFF: no `IB_ACCEPTANCE_SECRET_ROUTES=1` means no probe injection and no acceptance endpoint result. The endpoint keeps only one in-memory result and disappears with the static server process; no localStorage, IndexedDB, registry, boot-state flag, or config file is used to enable it.

The Host marker remains fixed and input-free. `IB.host.platform()` dynamically observes the existing Tauri globals/origin/WebView2 marker; native Project Knowledge still requires the existing `core.invoke` seam.

## G. Installed Root Proof

The P7 wrapper proved the following before and during the attempted probe:

- Host path was an isolated `%TEMP%\ib-p7-smoke\install-*\internalbeyond-host.exe`.
- `/__boot-state` bound the launcher root to that same isolated install.
- installed `InternalBeyond.html`, `assets/js/secret-routes.js`, runtime and service files came from the same payload root.
- no repository checkout path was accepted as the installed runtime root.

## H. Tauri Recognition

The bounded probe records `IB.host.platform() === 'tauri'` as `tauri`; it does not set or mock that value. The seam also supports the fixed `__IB_TAURI_HOST__` marker installed by the existing page-load/initialization path. No full `window` dump is used.

## I. Gesture Negative Tests

The fixed probe source contains the required checks:

- six clicks do not open Console;
- wait beyond 1800 ms, then one click still does not open Console;
- seven clicks at roughly 110 ms intervals are the positive gesture;
- Console close and the second seven-click sequence are separate checks.

No installed result was received, so these rows are not claimed PASS.

## J. Seven-click Gesture

The product gesture remains seven clicks within 1800 ms in `assets/js/secret-routes.js:301-325`. No threshold or trigger semantics were lowered. The fixed installed probe attempted the real `#nav-home` DOM element, but the installed WebView did not return a bounded completion result.

## K. Hidden Console DOM

The existing Web Core Console implementation remains `assets/js/secret-routes.js:229-297`, with scoped CSS and focus/Escape behavior. Browser/CDP and checkout Host visual checks passed it; the installed DOM probe did not produce evidence for `input`, prefix, close control, focus, or unknown-route state.

## L. Beyond Installed Flow

Not claimed as installed DOM PASS. The fixed probe would fill `Beyond`, submit the existing Console form, observe `#ibterm.ibterm-on`, then submit the existing Terminal `exit` path. Browser/CDP and checkout Host proved the same existing `IB.easterEgg.open()` handler, but those are Level 1/2 evidence for W3A.

## M. Middle Brain Installed Flow

Not claimed as installed DOM PASS. The fixed probe would reopen Console, submit `middlebrain`, observe `#ib-middle-brain-direct-root`, and close the existing P31 overlay. Browser/CDP and checkout Host proved existing P31 reuse, but installed DOM result was absent.

## N. Malicious Input Spot Checks

Resolver unit/CDP tests already pass the full malicious matrix. The fixed installed probe also includes a real Console-form spot check for `https://example.com` and requires `Unknown secret route.` with Console remaining open. No installed result arrived, so the installed spot-check is unproven in this run.

## O. Zero-model / Zero-native Side Effects

The probe sends no Direct Channel message and reports `modelCallsObserved: 0` / `directMessageSent: false`. The acceptance seam itself has no arbitrary invoke path. The installed lifecycle smoke remained 43/43, but the DOM probe did not return a result to independently close this row.

## P. Lifecycle Regression

Final test-only real smoke passed 43/43, including Host launch, visible/responding window, second-launch single-instance focus, five service surfaces, installed-root binding, running upgrade, exact runtime replacement, unrelated Node survival, user-data preservation, uninstall, and no browser opening.

## Q. Production Invariance

Production `dist/InternalBeyond-Setup-1.0.6.exe`, `SHA256SUMS.txt`, `update-stable.json`, root `VERSION`, production Inno/Tauri registry, shortcuts, install roots, and real user data remained unchanged. Test-only artifacts used the protected test AppId `{A4D9E7B3-1F86-4C2A-9D57-6B3E1C8F0A24}`.

## R. Cleanup

P7 cleanup removed owned test install/data roots, exact test processes, test registry/shortcut residue, test logs, and test build outputs. No broad image-name kill was used. The acceptance wrapper does not persist probe results.

## S. Remaining

The current blocker is specifically the installed WebView observation/result path: the WebView2 runtime did not expose the attempted DevTools target, and the fixed page-load probe did not return a bounded result through the test-only loopback channel. This is not evidence of a Secret Route semantic failure; it is insufficient Level-3 observation evidence.

## Closure Gate

| Check | Installed Host Evidence | Result |
|---|---|---|
| actual installed Host exe | P7 isolated root + 43/43 lifecycle | PASS |
| actual WebView origin | Host window/WebView exists; bounded probe result absent | DEGRADED |
| runtime recognized as Tauri | fixed probe could not report | DEGRADED |
| `#nav-home` exists | source/checkout evidence only | DEGRADED |
| 6-click negative | fixed probe not returned | DEGRADED |
| timeout reset | fixed probe not returned | DEGRADED |
| real 7-click gesture | fixed probe not returned | DEGRADED |
| Hidden Console visible | Browser/checkout PASS; installed DOM unproven | DEGRADED |
| Beyond real input / Terminal reuse | Browser/checkout PASS; installed DOM unproven | DEGRADED |
| Beyond close/return | Browser/checkout PASS; installed DOM unproven | DEGRADED |
| middlebrain real input / P31 reuse | Browser/checkout PASS; installed DOM unproven | DEGRADED |
| P31 side effects / close-return | existing P31 contract PASS; installed DOM unproven | DEGRADED |
| malicious input | resolver full matrix PASS; installed spot-check unproven | DEGRADED |
| model call count | probe sends no message; no installed report | DEGRADED |
| repository escape | P7 installed-root proof PASS | PASS |
| Host lifecycle regression | real smoke 43/43 | PASS |
| production invariance | production artifacts/registry/roots unchanged | PASS |

P32-W.3A = DEGRADED  
P32-W.3 remains DEGRADED.

## T. P32-W.3B Transport Diagnosis

The narrow W.3B follow-up isolated the earlier no-result condition without changing Secret Route semantics. The installed Host received the acceptance gate, registered the fixed source probe, and delivered `probe_started` to the same isolated loopback endpoint with a matching ephemeral runId. The original Host-to-launcher runId propagation gap and an endpoint-start/report race were fixed inside the acceptance seam.

The remaining installed WebView evidence is still insufficient for Level-3 closure: the fixed probe did not produce a trustworthy stable `document_state → tauri_recognized → #nav-home` result from the actual installed DOM. A bounded diagnostic snapshot showed an opaque/blank-shaped WebView context, while Host page-load payloads classified the target as `InternalBeyond.html`; this is retained as a WebView lifecycle/observation blocker, not treated as a Secret Route product failure.

See `docs/P32-W3B-ACCEPTANCE-PROBE-TRANSPORT.md` for the A–T evidence, exact timeline, fixes, stop boundary and cleanup record.

## U. P32-W.3C Lifecycle Evidence

W3C now proves a Host-side `INTERNALBEYOND` Started/Finished lifecycle with `documentSeq=1` and a bounded M3 result (`readyState=complete`, `origin=null`, `pathname=/`). The same result reports `tauri=false` and `navHome=false`; therefore the canonical WebView identity and DOM target remain unproven. The full W3A DOM flow was not resumed after this gate failed.

## V. P32-W.3D Identity Result

The bounded identity probe classified the Host payload as `HTTP + INTERNALBEYOND`, but the WebView JS context as `CUSTOM + OPAQUE + ROOT`; it observed `title/body` and the fixed Host marker, but not `IB.host` or `#nav-home`. W3A remains paused and DEGRADED.
