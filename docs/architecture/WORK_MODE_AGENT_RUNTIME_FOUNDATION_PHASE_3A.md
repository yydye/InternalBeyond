# Work Mode Foundation · Phase 3A: Work Result & Consent Closure

Status: Implemented, no formal UI
Date: 2026-10-09
Workflow: `project.audit.readonly`

## 1. Authority and Call Path

```text
local Workspace metadata preview
  -> explicit grantConsent(run, existing Provider profile, exact fileIds, expiry)
     -> Home Node stores the scoped consent record
  -> start(run, profile, consentId)
     -> preflight verifies exact Run/project/provider/file scope
     -> Middle Brain plan
        -> Work Mode-only consent check in the cognition port
        -> existing Astra resolves its effective Provider route
        -> Home Node checkConsent immediately before transport send
     -> Agent ModelPort turn
        -> Home Node checkConsent immediately before ModelPort.execute
     -> fixed Workspace read -> Observation -> further gated turns/review
     -> Home Node completeRun CAS transaction:
          Run completed + state Event + Work Result Artifact + idempotency
          + consent closed/revoked, all in one SQLite transaction
```

Project content is not sent by Run creation or `start()` alone. Missing,
expired, revoked, wrong-project, wrong-file, or changed-provider authorization
fails closed before the corresponding network send. The consent core is
separate from Chat/Role disclosure authorization; it neither reads nor writes
Chat Memory, Role facts, or Agent Memory.

## 2. Consent Contract

Home Node grants are created only for an existing queued Run and require an
explicit caller confirmation attestation. Run creation and Run start never
create a grant implicitly.

| Scope | Stored contract |
|---|---|
| Run | exact `runId` and unchanged `expectedVersion` at grant time |
| Project | exact local Workspace `projectRef`; it is not copied into Provider prompt bodies |
| Files | explicit, non-empty list of at most 200 Workspace `fileId` values; no wildcard/path grant |
| Providers | exactly two destinations (`agent`, `middle_brain`), each bound to an existing active API profile ID, provider, model, and SHA-256 route fingerprint |
| Lifetime | Home Node `issuedAt` / `expiresAt`; caller chooses 1 second through 1 hour; no default duration |
| Disclosure terms | fixed version `work-mode-egress-result-v1`; the preview also discloses the 90-day Result and 365-day Run/Event/idempotency/Consent retention |
| Confirmation | `confirmationMethod=explicit_user_action`, server timestamp, no credential or project content |

The route fingerprint hashes the exact profile reference, provider, model, and
configured endpoint string. The endpoint itself, query string, and credential
reference are neither sent to nor stored by Home Node. Middle Brain Work Mode
calls are default-deny even when invoked directly: `IB.workModeCognition.plan`
and `.review` require an authorization envelope and perform the Home Node
check inside the Work Mode-only cognition port. Astra checks the resolved
effective route before its HTTP send. The Agent Runtime checks the exact
ModelSpec route before each existing ModelPort call. Revocation and expiry
prevent later sends; they cannot retract bytes already sent in an in-flight
request.

`confirmed:true` is a trusted-client attestation, not cryptographic proof of a
human click. This phase has no consent UI or independent user identity service.
The HN endpoint remains behind the existing desktop private API authorization.
A formal user-facing display of the previewed providers/files/lifetimes and
confirmation/identity interaction is a Phase 3B gate.

## 3. Result Artifact

Results live only in Home Node's existing `home-node.db`, in the independent
`work_run_results` table. No Chat Memory, Agent Memory, IndexedDB result mirror,
or Memory Exchange path is used.

Artifact v1 is an allowlisted report:

```json
{
  "schemaVersion": 1,
  "summary": "...",
  "findings": [
    {"fileId":"...","path":"src/file.js","line":1,
     "severity":"critical|high|medium|low|info","title":"...","detail":"..."}
  ]
}
```

The store enforces exact keys, 8 findings maximum, field/size limits, relative
path boundaries, and authorized file IDs. Common credential strings are
redacted again at the persistence boundary; private-key blocks are rejected.
Only an approved, normalized report is stored. Prompts, source contents, review
excerpts, raw tool arguments, credentials, exception messages, and full provider
outputs are never stored.

`POST /internal/work/runs/:runId/complete` is the only completion path. It
requires the current Run version and an active grant. In one `BEGIN IMMEDIATE`
transaction it inserts the Artifact, CAS-updates the Run, appends the state
Event, records hashed idempotency data, and closes consent. The legacy generic
transition endpoint rejects `completed` with `result-required`. Repeating the
same completion request returns the existing artifact without another Event.
A failed Result insert rolls the Run update and Event back together.

`GET /internal/work/runs/:runId/result` reads the artifact. Explicit report
deletion is `POST /internal/work/runs/:runId/result/delete`; it clears only the
report payload and leaves a `deleted` tombstone, the completed Run, its Events,
and idempotency records intact. Phase 2 completed Runs without a stored report
are migrated to `legacy_unavailable` tombstones; no report is fabricated.

## 4. Lifecycle and Retention

| Record | Rule |
|---|---|
| Available Result payload | expires 90 days after atomic completion; lazy read or cleanup clears `report_json` and leaves an `expired` tombstone |
| Explicitly deleted Result | payload is removed immediately; `deleted` tombstone remains while the Run is retained |
| Run | terminal Runs are eligible after 365 days from terminal `updated_at` |
| Events | retained for the full Run lifetime; purged only with that Run |
| Idempotency hashes | retained for the full Run lifetime; raw request IDs are never stored |
| Consent | metadata and revocation status retained for the Run lifetime; closed on Run cancellation/failure/completion |
| Active Runs | never deleted by retention cleanup, regardless of age |

`POST /internal/work/retention` performs an explicit cleanup batch capped at 100
per collection; `GET` returns the policy. There is no background scheduler.
When terminal-Run retention elapses, one Home Node transaction deletes that Run,
its Events, Result/tombstone, Consent rows, and associated idempotency rows in
foreign-key-safe order. The idempotency guarantee lasts for the Run retention
period; after aggregate deletion, a reused request ID is no longer recognized.

Result expiry/deletion does not mutate terminal Run status or append a Run
Event. Consent changes are recorded in the Consent ledger (`issuedAt`,
`confirmedAt`, `expiresAt`, `revokedAt`, `revocationReason`), not mixed into the
version-equals-Event-sequence Run state stream.

## 5. Verification

- Production Home Node/SQLite integration covers schema v1 -> v2 migration, consent auth/scope/provider/expiry/revocation, atomic completion, Result read/delete/idempotency, bounded cleanup, and active-Run preservation.
- A SQLite fault-injection trigger makes Result insert fail; the test verifies Run remains `running`, version/Event count are unchanged, and no Result exists.
- Mock Runtime covers default-deny without consent, exact provider/file scope, route change, expiry, revocation-triggered cancellation, completion Artifact, and existing Phase 2 model/tool/cancel/restart paths.
- `test_middle_brain_seam.js` runs with an isolated local Memory mode and synthetic credential resolver; it does not weaken production Memory fail-closed behavior or write a Memory fixture. Work Mode checks prove no-auth and revoked consent do not reach even the local mock Astra endpoint.

No live Provider/Middle Brain invocation was attempted. This shell has no
attached authenticated WebCore/Vault session, and this request did not identify
a concrete Workspace project, file list, Provider profile, or per-project
external-content grant. The real-call requirement is **blocked**, not passed.

## 6. Phase 3B Admission

- Build a user-facing consent interaction that previews the exact project, file IDs, both destination profiles/routes, and duration, then creates the grant only after confirmation. Do not treat the current boolean attestation as a human-identity proof.
- Perform one live audit only after the user selects the exact project/file scope and Provider profile and the existing credential resolver reports usable credentials. Verify both real outbound destinations and ensure revoke/expiry stops subsequent sends.
- Add a Result viewer and explicit delete action without projecting artifacts into Memory; keep Home Node as the only Result authority.
- Changed provider routes require a new grant; keep route fingerprints synchronized with active profiles.
- Add Home Node executor lease/heartbeat before supporting multiple origins or remote runtime owners. Keep cleanup explicit until an approved host-owned maintenance trigger exists.
- Continue to exclude Agent Memory, Memory Exchange, Automation, generic Event Bus/Tool Registry, and Chat/Role Agent Loop changes.
