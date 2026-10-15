# The Lost Beyond — DSH Native Work UI P1: Host Authority Integration

Date: 2026-10-11. DSH source revision: `d743267388641bc76f17c45ce8b4c231aed1d32c`.

## Authority and lifecycle

The official DSH Web Session is the visible handle for one Home Node Work Run. `work_run_dsh_sessions` stores a unique `session-<UUID> → runId` binding in the Home Node SQLite ledger; it stores no transcript, prompt, Provider credential, file content or duplicate Result. The table is additive schema v5 and old Runs migrate with no fabricated links.

Binding may be recorded while a Run is queued with no Consent. That action grants no execution authority. The Run must also have a live, file-scoped, Agent/Review Provider Consent before starting. The existing Work Mode Controller checks the scope, explicitly accepts local Result storage, then binds the active Consent to the same DSH Session before the Home Node DSH Host starts.

The P1 composer replaces DSH's ordinary send control with a Home Node Run card. It can bind, execute, show sanitized Host execution events, cancel, and read the persisted Work Result. The visible DSH Session never sends an independent model request. The standalone Web profile adapter rejects generation, and its Tool Gateway guard denies every direct tool call. The only model and file execution path remains the Home Node `dshHost.run` ACP Host, which validates the Session binding and Consent at startup and before each model or Workspace operation.

The ACP child is the Run's executor; its Agent session is process scoped as before. The Web Session id is the durable UI-to-Run correlation. Result and Run state exist only in Home Node. The Web Session row remains DSH's normal local Session catalog entry, with no copied Result artifact.

## Provider route identity

`assets/js/work-mode-provider-route.js` canonicalizes provider/model identifiers, endpoint URL, profile reference and Vault reference. Consent hashes this resolved route; Home Node registry projection uses the same endpoint representation; `middle-brain-astra.js` sends the same canonical endpoint; and the DSH Host resolves and compares the fresh registry route before sending through `NodeModelPort`. Invalid, credential-bearing URL authority, unsupported protocol, control characters and overlength endpoints fail closed. DTO projection no longer truncates an endpoint before consent hashing.

The Hub still trusts the configured provider endpoint. This work only closes representation drift between preview, grant, and the pre-send check; a route change still requires a fresh explicit Consent.

## Validation

Focused tests cover canonical route fingerprints, pre-Consent Session linking, one-to-one Run/Session identity, binding persistence across Home Node reopen, authenticated HTTP binding, denial of an unbound ACP Run, route equivalence/change, Consent invalidation, cancellation, timeout, child crash, Work UI reauthorization and Result persistence.

Real Tauri WebView2 acceptance passed in Synthetic mode. One DSH Session mapped to one Home Node Run; the two visible Provider routes and selected file were consented; two Fake Provider calls produced an authorized Project Tool read and a persisted Home Node Result. After iframe refresh, the same Session reopened that Result. A second Run reached `running` with its Fake Provider request held, then the DSH cancel control cancelled the Home Node Run, closed the held request, and left no Result. The test observed zero DSH Gateway `session/prompt` calls, zero external requests, zero failed DSH resources, zero WebView errors, and a working Native Work UI fallback. Run ids, versions, Session bindings and results are checked against Home Node APIs.

The WebView run also exposed and fixed three integration gaps: Home Node's public Work Run facade had not exposed the new binding routes; the Workspace bridge used `IB.workspace` instead of the existing `IB.workspace.files` facade and therefore never polled; and Consent startup compared the display-only `endpointLabel` as if it were part of the route scope. The Work UI DSH status poll now uses the available timer, and Synthetic Fake Provider controls reset the deterministic tool-response sequence between Runs.

## Run

Build the pinned DSH checkout with the P0 instructions, then restart the isolated Synthetic desktop so Home Node loads schema v5 and the guarded P1 Web profile. Run the Dev Launcher in an interactive PowerShell window so it keeps the Synthetic Fake Provider alive; start the candidate Host from the IB root:

```powershell
node runtime/ib-dev-launcher.js stop --synthetic
node runtime/ib-dev-launcher.js start --synthetic --dsh
node runtime/dsh-native-ui-p0.js start
```

Run focused verification:

```powershell
node --test tests/test_work_run_dsh_session.js tests/test_work_mode_provider_route.js
node tests/test_home_node_work_runs_client.js
node tests/test_home_node_work_runs.js
node tests/test_work_mode_consent_ui.js
node tests/test_work_mode_runtime.js
node --test tests/test_dev_synthetic_seed.js
node tests/test_dsh_native_ui_p0.js
node --test tests/test_dsh_host_adapter.js
node tests/test_dsh_native_work_ui_p1_webview.js
```
