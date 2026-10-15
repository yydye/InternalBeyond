# The Lost Beyond — DSH Native Work UI P0

Date: 2026-10-11. Status: superseded by [P1 Host Authority Integration](DSH_NATIVE_WORK_UI_P1.md). P0 established the real Synthetic Tauri WebView2 surface.

P0 first connected an isolated Fake Provider directly to the DSH Web profile. P1 removes that execution path: the official DSH Web Gateway now refuses direct model and tool execution, and its composer submits a request to the existing Home Node Work Mode Controller.

## Run

The source checkout defaults to `E:\DeepSeek-Harness-Mock-PoC`. `IB_DSH_SOURCE_ROOT` may select another checkout. The launcher requires HEAD `d743267388641bc76f17c45ce8b4c231aed1d32c` and no tracked changes relative to that commit. Existing unrelated untracked upstream PoC files are preserved; they explain the upstream UI's `-dirty` build label.

Build prerequisites, once in that source checkout:

```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec tsx scripts/build.ts --artifacts-only
```

From the IB checkout, with Synthetic Dev already running:

```powershell
node runtime/ib-dev-launcher.js start --synthetic --dsh
node runtime/dsh-native-ui-p0.js start
```

The second command owns a standalone development process. It does not restart an existing Dev app. Open Work and select the DSH candidate. A Dev page opened before this change needs to load the new entry script; this acceptance hot-mounted only the candidate to preserve the existing Native Work state. Future ordinary page loads include it through `InternalBeyond.html`.

Stop the candidate independently:

```powershell
node runtime/dsh-native-ui-p0.js stop
```

This stops only the official DSH Web profile. It does not stop Tauri, Home Node, or the Home Node DSH ACP Host.

## Composition and isolation

- `23140`: P0 readiness/bootstrap control. Only the Synthetic Dev origin `http://127.0.0.1:23130` receives the official launch URL; bootstrap tokens are redacted from host logs.
- `23141`: official DSH Web profile, generated Typert descriptors, HTTP RPC and `/api/remote.mux` WebSocket. There is no custom Typert implementation or proxy.
- The direct profile Fake Provider from P0 is retired. Synthetic model requests now use the existing Home Node NodeModelPort and Synthetic Fake Provider at `23139` after an authorized Run starts.
- All P0 data, profile patches, settings, credentials for DSH's own browser login, and Synthetic Session fixtures live below `%LOCALAPPDATA%\InternalBeyond\dev-synthetic\dev-sandbox\dsh-native-ui-p0`.
- Child environment inherits only OS/executable support. Provider keys, product tokens, proxies and `NODE_OPTIONS` are excluded. `DSH_HOME`, user/config directories, skill roots and temp directories point into the Synthetic root. No formal app snapshot is taken.
- Direct DSH Web model requests fail with `IB_WORK_RUN_REQUIRED`; its DSH Tool Gateway guard denies every tool. P1 work runs execute the official ACP Agent through the Home Node Host Adapter with the consented read-only Project Tool.
- Small subclasses retain official Session/Workspace controllers and filesystem behavior while rejecting paths outside the Synthetic workspace and denying filesystem mutations. The picker returns only that workspace. Native file handoff and browser/terminal panels are disabled.
- The browser extension uses the official ModuleLoader and theme service. Origin/source-checked messages synchronize light/dark from the IB parent; theme changes stay in Synthetic settings. The candidate retains the official DSH component styling; full IB visual adaptation is deferred.

This runtime has Synthetic fixture storage, not an alternative authority for IB Work Runs, Results, Consent, Workspace or Memory. It imports no Home Node store, ACP host, production Vault or IB runtime executor.

## Focused evidence

Commands:

```powershell
node --test tests/test_dsh_native_ui_p0.js
node tests/test_work_mode_consent_ui.js
```

These are the P0 direct-Fake baseline checks. The original P0 WebView dialogue script is historical: P1 intentionally replaces that direct model path. Use `tests/test_dsh_native_work_ui_p1_webview.js` for current real-WebView2 acceptance.

P0 initially verified direct Synthetic Session/Gateway behavior. P1 acceptance replaces the local echo behavior; use the P1 verification record for current model/tool admission evidence.

Evidence: `.dsh-research/native-work-p0/acceptance.json`, `webview-light.png`, `webview-dark.png`. All messages and session fixtures used for these captures are synthetic.

## Minimum next integration

The existing ACP Host launches a per-Run `acp` profile, mediates model/files through Home Node, keeps transcript data in process memory and completes a scoped Work Result. The candidate launches the official `web` profile with native Session controllers and isolated Synthetic transcripts. These are different compositions, not interchangeable UI URLs.

Keep the official Web Gateway, client and native Session event model. Add a Home Node-owned binding between one Work Run and its DSH execution Session. Route all model sends and Workspace reads through the existing authorization/Vault/ModelPort and Project Tool capabilities. Keep Home Node CAS, Consent and Result completion authoritative; use DSH events as presentation input. Select one executor per Run, retaining ACP/Native fallback rather than running both for the same Run. Do not copy DSH fixture JSONL into Home Node as a second Run/Result store.

Before real Provider admission: unify effective Provider Route resolution for preview/grant/send; restore full Consent checks in the execution path; integrate Middle Brain Plan/Review; separately define Agent Memory and transcript persistence rules. Replacing the UI does not fix the current route-source disagreement. These migrations, real Provider validation and full IB styling are outside P0.
