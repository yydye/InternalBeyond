# Work Mode Foundation — Phase 3B.2 Agent Memory First Consumer

Date: 2026-10-10
Status: Implemented with isolated tests. No real Provider E2E or production-data operation was performed.

## Admission and Scope

Work Result remains the only first Agent Memory write consumer. The user selects
exactly one report summary or finding, reviews a transient Memory Candidate, and
confirms a dedicated Agent Memory write. This phase supports `Observation` only;
other memory types need type-specific authoring and review surfaces. There is no
full-report import, automatic writer, Recall, Consolidation, Memory Exchange, or
new Runtime tool permission.

## Candidate Contract

```text
MemoryCandidate = {
  candidateId,                 // transient UI identity; not persisted
  type: "Observation",
  projectRef,                   // copied from the Home Node Run
  payload: {
    statement,                  // exact summary or one selected finding
    contextRef: "wm:<selectionRef>"
  },
  provenance: {
    sourceKind: "work_result_ref",
    sourceRef: resultId,
    sourceRevision: String(resultSchemaVersion),
    selectionRef                 // "summary" or "finding:N"
  },
  basedOn: { runId, resultId, resultSchemaVersion },
  expectedStoreRevision,
  expiresInMs: 30 days
}
```

The candidate exists only in UI memory; refresh discards an uncommitted preview.
The candidate view displays Project, Run, Result, Observation type, provenance,
selected text, and the plaintext persistence warning. A checkbox plus an explicit
submit are both required. The API also rejects absent/false confirmation.
The private generic create/update/supersede/retract routes likewise require a
confirmation marker; no unconfirmed CRUD route is left as a write bypass.

## Authority and Access Checks

The UI calls the existing Workspace project listing and requires the exact
`projectRef` to exist both when building the preview and immediately before commit.
The Home Node endpoint accepts no `projectRef`, payload, or type from the caller.
It re-reads the completed Run and current Work Result, checks Result identity,
availability, expiry and project binding, then derives text from only `summary` or
one in-range finding. It writes through the existing Agent Memory SQLite Authority.

```text
POST /internal/agent-memory/work-results/candidates/commit
{
  runId, resultId, selectionRef,
  expectedStoreRevision, confirmed: true
}
```

The project-specific query boundary remains `projectRef`. A candidate retry with
the same project, type, Result and selection returns the existing record before
checking the stale revision, so a lost HTTP response does not create a duplicate.
Any different candidate with a stale `expectedStoreRevision` returns
`VERSION_CONFLICT` without mutation. A deleted or expired Result cannot create a
new candidate. Deleting the Work Result does not implicitly delete its confirmed
memory record.

The UI uses the current single-user Workspace authority in browser IndexedDB;
Home Node can independently verify Run/Result/project binding, but it does not
own the Workspace project ACL. This is not a multi-user or hostile same-account
process boundary. The desktop Home Node token remains the private API trust gate,
not cryptographic evidence of a human click.

## Retention and Data Protection

Every new Observation defaults to 30 days if no expiry is supplied. The Work
Result consumer always uses that default from commit time. An Observation is
excluded from active queries at expiry; bounded explicit cleanup clears payload
and creates an expired tombstone. Superseded, retracted and expired tombstones
remain eligible for bounded explicit purge 365 days after `terminal_at`; no
background scheduler is added. Retraction requires the record revision and a
separate explicit UI confirmation; it clears payload but does not securely erase
old SQLite pages or backups.

`agent-memory.db`, backups, downloads, and cross-install imports remain plaintext.
The candidate UI warns at the write point. Known credential-shaped content is
rejected by existing Agent Memory validation, and Work Result sanitization is
reused, but this is best-effort pattern filtering rather than DLP. No user
acceptance of plaintext backups, production export, encryption, or secure erase is
claimed. No real personal or project data was backed up or restored in this phase.

## Verification

- `test_work_mode_consent_ui.js`: project membership recheck, single-item preview,
  explicit confirmation, duplicate submit, CAS conflict, retraction, and sensitive
  content failure.
- `test_home_node_work_runs.js`: authenticated endpoint rejects missing
  confirmation, caller project injection and mismatched Result; reuses the exact
  selected Result content; rejects a credential-shaped sanitized summary; confirms
  idempotent retry and blocks candidate creation after Result deletion.
- `test_agent_memory_store.js`: 30-day Observation default, project isolation,
  provenance, idempotent selection identity, CAS, sensitive input rejection, and
  Chat/Chat Memory persistence/export separation.
- `test_agent_memory_cross_install.js`: source and target use separate temporary
  installation directories; verifies portable SQLite export, full replacement,
  provenance/revision links, and failed-swap rollback preserving target data.
- `test_home_node_work_runs_client.js`: closed candidate request body excludes
  caller-supplied project and content.

## Phase 3C Admission

- Phase 3B.3 freezes local plaintext under the OS-user-scoped Home Node directory,
  with ACL/full-disk controls required but not claimed to be verified; no automatic
  external backup is admitted. Phase 3C still requires explicit risk acceptance or
  an implemented OS-keystore-backed encryption strategy and platform checks.
- Current project authorization is single-user/local Workspace only. Multi-user
  or remote access remains disabled until a server-verifiable project owner
  authority exists.
- Memory Exchange is default-deny, with no automatic or bidirectional sync.
- Keep real Provider + Middle Brain + readonly tool + Result E2E as a distinct
  formal Work Mode enablement gate; it remains unverified here.
- If adding another memory type, build its own user-authored fields and preview;
  do not infer Decision, Fact, Procedure, or Project semantics from an entire report.
- Treat any Agent Memory read/Recall consumer as a separate admission with scoped
  project access, provenance display, expiry behavior, and zero Chat Memory writes.
- Run isolated Agent Memory, Home Node, Chat Memory, Role, Vault and P28 guards.
