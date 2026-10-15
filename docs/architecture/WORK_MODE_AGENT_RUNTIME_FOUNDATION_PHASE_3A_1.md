# Work Mode Foundation — Phase 3A.1

Date: 2026-10-09
Status: Consent UI and Home Node Result access implemented; real Provider validation not performed.

## Scope

This phase adds only the minimum desktop surface required to inspect and authorize
`project.audit.readonly`, inspect/delete its Work Result, and make the existing
Phase 3A authority usable without introducing a new Agent Runtime authority.

No Agent Memory, Memory Exchange, Automation, Shell, write tool, Subagent, Chat,
Role, Chat Memory, Provider, or Vault authority was added or modified by this
phase. The Work Result index is a bounded read API on the existing Work Run /
Artifact Authority, not a browser-side index or second database.

## Authorization Contract

The UI flow is intentionally split into local preparation, consent, and execution:

1. The user selects an existing Workspace project and existing Agent Provider
   Profile. Home Node creates a queued Run locally; this step sends no project
   content to a Provider.
2. The Work Runtime builds a fresh authorization preview from the current Run,
   Workspace manifest, Agent ModelPort route, and the bound Middle Brain profile.
   The UI displays both actual Provider destinations, provider/model/profile,
   endpoint origin/path, project reference, and each eligible file path and size.
3. The user selects files individually. The default is no files selected.
4. Before consent, the user separately acknowledges (a) exact Provider/project/
   file egress and purpose, and (b) the currently unencrypted local Result storage
   risk. Consent expiry is bounded to 5 minutes, 15 minutes, or 1 hour.
5. “Save egress authorization” persists consent in Home Node and does not start
   the Agent. “Start readonly audit” is a distinct user action.
6. Immediately before grant/start, the UI refreshes the preview and compares the
   Run version, project, terms, both Provider route fingerprints, endpoint labels,
   and Workspace file identities/paths/sizes. Any difference clears confirmation;
   if a consent already exists, the UI attempts to revoke it. A failed revocation
   leaves the UI fail-closed. Runtime and Home Node independently check the active
   consent, exact Provider scope, file IDs, terms version, and expiry before egress.
7. Provider/Profile or selected-file changes revoke the known consent. Run cancel
   uses the Home Node cancellation path, which closes Run consent. Expired/revoked
   or stale-term consent cannot start or continue provider calls.

Home Node continues to be the durable authority. Consent requests use the existing
private, desktop-token-protected Work Run API. The user-facing checkboxes are an
explicit UI contract, not an identity proof: any process already holding the
Home Node desktop token remains within that token's existing trust boundary.

## Refresh, Interruption, and Results

On Work Mode page load/refresh, the UI asks Runtime to reconcile dangling queued,
running, or cancel-requested Runs to failed/cancelled with `runtime_interrupted`,
then reads active Runs and Result metadata from Home Node. It never restores consent
from browser storage, resumes model turns, or auto-starts a Run. A queued Run whose
consent was granted before refresh can be cancelled (revoking its consent); it is
not silently re-authorized.

`GET /internal/work/runs/results?limit=N` lists at most 100 recent
`project.audit.readonly` Result metadata records. It does not return report text.
The existing per-Run Result read route returns the artifact; the UI renders it with
text nodes. Deletion requires a separate confirmation dialog and uses the existing
Home Node Artifact Authority CAS delete path. It tombstones the Result and preserves
Run Events; it does not claim physical erasure.

The UI does not store Run IDs, consent IDs, reports, or result-index copies in
localStorage, sessionStorage, IndexedDB, or Chat Memory. After refresh, Home Node
is queried again.

## Data Lifecycle and At-Rest Decision

| Record | Authority and stored fields | Lifetime / deletion |
| --- | --- | --- |
| Run | Home Node `work_runs`: workflow, project ref, status/version/timestamps | Terminal aggregate is eligible for bounded explicit cleanup after 365 days; active Runs are never purged. |
| Events | Home Node `work_run_events`: state/event type, versions, closed reason codes, timestamps | Purged only with the terminal Run aggregate. Prompts, observations, and source are not Events. |
| Consent | Home Node `work_run_consents`: exact Provider fingerprints, project ref, file IDs, terms version, confirmation and expiry/revocation metadata | Expiry is checked on use; consent rows are removed with their Run after the terminal retention period. Revoke/cancel/terminal Run closes consent. |
| Idempotency | Home Node hashed request key/hash, operation, Run/result status/version, timestamp | Purged only with the terminal Run aggregate; idempotency is not guaranteed after that retention boundary. |
| Work Result | Home Node `work_run_results.report_json` and result/tombstone metadata | Report expiry is 90 days. Expiry is enforced on Result read and by explicit bounded cleanup; there is no background cleanup scheduler. User deletion clears the logical report body and leaves a tombstone. |

### Frozen at-rest policy

**Current policy: local plaintext Home Node Artifact, protected only by the existing
private Home Node access path and the host account's filesystem boundary. This app
does not encrypt the Result database at rest.** The UI and consent terms disclose
this before the user can grant egress. The app does not inspect or enforce full-disk
encryption and does not set/verify an ACL on the Home Node data directory; any OS
profile ACL is inherited platform behavior, not an application guarantee. The
Result table is logically separate from Chat and Memory data, but physically shares
the existing `home-node.db` file.

This policy does not protect against a malicious process running as the same OS
account, an administrator, offline disk access, database/WAL copies, backups, or
application-memory inspection. SQLite report clearing is logical, not secure
erasure: old database pages, WAL frames, filesystem snapshots, and backups may
retain bytes. Token redaction is pattern-based and cannot guarantee that arbitrary
project secrets are absent from model-generated report text. The report is
therefore sensitive local project data even though source files, prompts, raw tool
arguments, credentials, and complete model output are not intentionally persisted.

Operational rule for Phase 3A.1: do not audit a project whose Result is not
acceptable as plaintext in the local account profile. For confidential projects,
use a trusted, account-locked host with host-level full-disk encryption enabled;
this is a user/host prerequisite and is not verified by IB. If that assumption is
unacceptable, do not proceed. Static encryption is **not implemented** and must not
be represented as present. Any future encryption work must select an OS-protected
artifact key strategy, define recovery/rotation and WAL/backup behavior, and must not
reuse or duplicate Provider/Vault credentials.

## Implementation

- Added minimal `work-mode` route for project selection, existing Provider Profile
  selection, per-file preview, explicit egress and at-rest confirmations, bounded
  expiry, separate grant/start/cancel/revoke actions, active Run refresh, Result
  reading, and explicit Result deletion.
- Added a Work Result metadata-list method to the existing Work Run Store, private
  Home Node HTTP API, `home-node-client`, and Home Node facade. The index excludes
  report content and uses the existing Home Node token/authentication boundary.
- Added a Runtime recovery entry point for page refresh. It only terminalizes
  dangling Runs; it never resumes an Agent loop.
- Bumped consent terms to `work-mode-egress-result-v2`. Phase 3A `v1` consent is
  rejected as stale by the current Runtime and cannot authorize egress under the
  updated plaintext-at-rest disclosure.
- Added focused tests for denied implicit consent, separate storage-risk
  acknowledgement, duplicate submission, Provider/file scope invalidation, refresh
  without resume, cancellation/revocation, Result read/delete, private Result index,
  and report-free Result metadata.

## Validation Record

Automated tests use Mock ModelPort, Middle Brain, Workspace, and Home Node fixtures;
they are not evidence of a live external Provider call. Existing real local Home Node
HTTP/SQLite tests verify token gating, persistent Result metadata, no report body in
the index, deletion tombstone, CAS, and restart persistence.

**Real Provider + Middle Brain + readonly tool + persisted Result call: NOT RUN.**
No real project/file scope was selected in this turn and no user operated the consent
UI. No external call was attempted. Credential availability was not probed because
there was no user-authorized target. Synthetic tests or the task request itself are
not treated as user consent.

## Phase 3B Gate

**Not admitted yet.** Before Phase 3B adds any new domain or persistence behavior:

- A user must select a real project, inspect exact files and both actual Provider
  routes, separately accept the plaintext Result risk, and confirm egress in the UI.
- With existing Resolver/Vault credentials, complete one explicitly authorized
  real `project.audit.readonly` call through existing Provider + Middle Brain,
  verify read-only Workspace boundaries, and read the persisted Result back from
  Home Node. Record actual Provider/model, scope, timestamps, Result status, and
  deletion outcome without recording prompts, source, credentials, or full output.
- Verify in a live/local integration pass that cancel, provider/file change, expiry,
  UI refresh, and interruption stop egress or leave a terminal non-resumable Run.
- Decide whether plaintext plus a verified host-encryption prerequisite is an
  acceptable product policy. If not, implement and audit an OS-protected artifact
  key design, including WAL/backup/deletion behavior, before admitting confidential
  project results.
- Re-run focused Chat, Role, Chat Memory, Vault, Middle Brain seam, Work Run, and
  consent UI regressions; confirm no Agent Memory/Exchange writes or new Provider,
  Credential, or Tool authority.
