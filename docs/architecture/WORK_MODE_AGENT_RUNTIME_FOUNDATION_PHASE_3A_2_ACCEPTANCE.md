# Work Mode Foundation — Phase 3A.2 Acceptance

Date: 2026-10-10
Status: **BLOCKED — awaiting user-operated consent UI and explicit plaintext-storage acceptance.**

## Decision

No real Provider request was made. The user required that a real run happen only
after they personally confirm through the Work Mode UI. No UI confirmation, real
project/file scope, or plaintext-at-rest acceptance was received in this turn.
Credential availability was not probed because there was no authorized target.
No synthetic confirmation was treated as user consent.

No real non-sensitive Workspace project was created: the app WebView was not
opened or driven. Temporary project references below belong to isolated test
fixtures and do not represent a rendered production UI or a live Workspace.

## Offline Audit Evidence

- UI source and controller tests verify the displayed Provider destinations,
  individual file scope, default-off selection, distinct consent/start actions,
  storage-risk acknowledgement, route/file change invalidation, and no automatic
  restart. A Node controller fixture is not a browser/WebView interaction test.
- Runtime tests verify that model turns require a persisted active consent, reject
  stale terms, changed Provider routes, expired/revoked authorization and files
  outside the authorized set; the read-only adapter rejects disallowed paths and
  supports no Shell/write operation.
- Home Node integration tests use isolated temporary SQLite and synthetic local
  tokens. They verify private API auth, Work Run CAS, atomic Result completion,
  Result survival across Store close/reopen, metadata-only Result listing, explicit
  logical deletion/tombstone, and preservation of Run Events.
- Middle Brain seam tests verify the consent gate before its mock Astra transport.
  None of these tests reaches an external Provider.

### Expected Egress by Code Path

The following is source-contract evidence, not a captured live HTTP request:

- Middle Brain plan sends the selected files' `fileId`, relative path, and size to
  its existing configured Provider. `projectRef` is used for local scope checking
  but omitted from the plan prompt payload.
- Agent ModelPort turns receive the bounded audit prompt, plan, and contents read
  by `project.read_file` for user-selected files. The adapter caps each file at
  128 KiB and total reads at 512 KiB, redacts several common credential patterns,
  and rejects known key files/extensions. Pattern redaction cannot certify
  arbitrary project content as non-sensitive.
- Middle Brain review sends the proposed report and bounded evidence excerpts
  (3,000 characters per file; 18,000 aggregate). These are external egress too.
- Provider routes and consent are rechecked before each applicable send. This
  claim has only mock/local test evidence here; live Resolver behavior, actual
  endpoint serialization, response shape, cancellation timing, and real content
  were not observed.

## Storage Acceptance

The current disclosure remains accurate: Result JSON is plaintext in the existing
`home-node.db`; expiry/aggregate cleanup is not scheduled; deletion is logical and
may leave SQLite pages, WAL frames, or backups. The UI has a separate storage-risk
checkbox, but no user checked it in this turn. **Acceptance: NOT RECEIVED.**

The desktop-token API's `confirmed` field is an authenticated-client attestation,
not cryptographic proof of a human click. Any process already holding the trusted
Home Node desktop token is inside that existing local trust boundary. This phase
did not change that authority.

## Tests Run

- `node tests/test_work_mode_consent_ui.js` — passed.
- `node tests/test_work_mode_runtime.js` — passed.
- `node tests/test_work_mode_workspace.js` — passed.
- `node tests/test_work_mode_middle_brain.js` — passed.
- `node tests/test_middle_brain_seam.js` — 0 failed; Work Mode cases used mock consent/Astra.
- `node tests/test_home_node_work_runs.js` — passed, including Result reopen/read/delete.
- `node tests/test_home_node_work_runs_client.js` — passed.

No full test suite was run. No production Home Node data was read or written by
these tests; Home Node integration data used test-owned temporary directories.

## Phase 3B Admission

**NOT ADMITTED.** The live acceptance conditions remain unmet. Admission requires
the user to operate the actual UI with a non-sensitive temporary Workspace project,
inspect both resolved Provider routes and exact file scope, explicitly accept the
plaintext-storage warning and egress, then permit one real Resolver-backed run.
That run must verify actual Agent/Middle Brain requests, local-only tool reads,
Review, persisted Result read after refresh, and explicit deletion. Until then,
real credential availability and mock-versus-live behavior remain unknown.
