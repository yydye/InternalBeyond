# Work Mode Foundation — Phase 3B.1 Agent Memory Lifecycle & Recovery

Date: 2026-10-10
Status: Contract frozen before implementation; real Provider E2E remains a separate Work Mode enablement gate.

## Backup, Export, and Restore Contract

### Boundary

- Backups are consistent SQLite online snapshots of `agent-memory.db`, created
  through the existing Home Node SQLite backup capability. They are stored under
  the validated Home Node data directory in `agent-memory-backups/`, with opaque
  `amb_...` IDs and no caller-selected filesystem path.
- A backup is also the portable Agent Memory export artifact. An explicit download
  returns the SQLite bytes as `application/vnd.sqlite3`; it contains only the Agent
  Memory database. It is not a Chat JSON export and is never appended to
  `home-node.db` or `InternalBeyondDB`.
- Snapshot files are plaintext and sensitive, like the source database. They include
  active rows and may carry SQLite pages from earlier logical deletes. Keep them
  inside the existing user-account data boundary, do not log their contents, and
  require explicit deletion. At most 100 snapshots of at most 128 MiB each are
  admitted. Their retention boundary is 30 days, cleaned only by a bounded explicit
  Home Node operation; there is no scheduler. Filesystem deletion is not secure
  erasure.

### Validation and Compatibility

Before export or restore, validate the SQLite `quick_check`, foreign keys, exact
Agent Memory table/column set, payload/provenance schema, record status/revision
invariants, and sensitive-content constraints. Reject Chat/Home Node database
files, unknown/future schemas, corrupt files, and snapshots with unexpected tables.

Agent Memory schema v1 snapshots migrate forward to v2 in a staging file before
restore. Only v1 and current v2 are supported; there is no silent downgrade. The
v2 migration adds the store revision, supersession back-link, and Observation
expiry metadata without changing Chat Memory schema or `DB_VER`.

### Restore, Conflict, and Rollback

- Restore is a whole-database replacement, never a merge. Snapshot records are
  restored together so `supersedes` links remain consistent.
- An open database restore requires `expectedStoreRevision` and explicit
  `confirmed: true`. Any intervening write yields `VERSION_CONFLICT` and leaves
  both live data and snapshot untouched. If the current Agent Memory DB is
  unavailable/corrupt, recovery may use a null expected revision only with the
  explicit recovery confirmation path.
- The source is validated and staged first. Before replacing the live file, Home
  Node creates a separate pre-restore rollback snapshot. It then closes the store,
  swaps files on the same volume, reopens and checks the result, and removes the
  rollback copy only after successful validation. Any swap/open failure restores
  the old file and reopens the previous authority. No partial record merge is
  possible.
- Successful restore advances the target's `storeRevision` once beyond its
  pre-restore revision; it does not adopt an older source revision. Record-level
  revisions and provenance remain as stored in the snapshot.

## Five-Type Lifecycle Contract

| Type | Validity and replacement |
| --- | --- |
| Project | Active until explicit update, supersede, or retract. No automatic expiry. |
| Decision | Active indefinitely unless revised, superseded, or retracted. Superseding creates a new record and preserves a linked historical revision. |
| Fact | Active indefinitely unless revised, superseded, or retracted. Old/new records retain bidirectional supersession links and per-record revisions. |
| Observation | New records default to a 30-day lifetime when no expiry is supplied. Explicit `expiresAt` may override it. Once expired it is excluded from default active queries and its content is not returned. Explicit bounded cleanup clears the payload and retains an expired tombstone. No expiry scheduler is added. |
| Procedure | Active until explicitly revised, superseded, or retracted. No automatic expiry. |

Update/supersede/retract require `expectedRevision`. A stale write returns the
current safe record projection and performs no mutation. Superseded payloads remain
available only through explicit historical queries until their terminal retention
period elapses. Retraction clears payload immediately. Superseded, retracted, and
expired tombstones are eligible for explicit purge after 365 days; active records
are never automatically removed. Cleanup APIs are bounded and unscheduled.

Expiry removes an Observation from effective active use at `expiresAt`, even before
the physical tombstone cleanup runs. A delayed cleanup can therefore leave expired
bytes in the plaintext SQLite file; this is not secure erasure.

## First Usage Contract: Work Result to Memory Candidate

Phase 3B.1 froze this interface without a writer. Phase 3B.2 implements the first
consumer using only a selected Work Result summary or one finding:

```text
MemoryCandidate = {
  candidateId,
  type: Project | Decision | Fact | Observation | Procedure,
  projectRef?,
  payload: type-specific closed object,
  provenance: { sourceKind: "work_result_ref", sourceRef: resultId },
  basedOn: { runId, resultId, resultSchemaVersion }
}
```

The candidate is transient and not an Agent Memory row until confirmed. The
implemented first consumer accepts only an Observation; Home Node derives the
selected text and project from an available, completed Result rather than trusting
caller-supplied content or project scope. The UI checks current Workspace membership
at preview and commit. An explicit confirmation checkbox precedes the write; stale
store revisions fail with `VERSION_CONFLICT`, and retrying the same result/selection
returns the original record. Retraction requires a separate confirmation and clears
the payload. This does not add an automatic Runtime writer, Recall, consolidation,
or Memory Exchange.

## Data Protection

`agent-memory.db`, online backups, downloads, and imported snapshots are plaintext
at rest. The existing Home Node token protects HTTP access but does not encrypt
files, verify filesystem ACLs, or protect against same-account malware, an
administrator, offline disk access, or copied backups. Snapshot IDs and checksums
are metadata, not encryption. Secret-pattern rejection is best-effort and cannot
make arbitrary notes non-sensitive. No Provider/Vault credential is used as an
Agent Memory encryption key.

## Phase 3B.2 Decisions and Remaining Gates

- Work Result is the only first consumer. Its Work Mode UI accepts one summary or
  finding at a time and creates only a 30-day Observation. Project, Result, selected
  location, type, and provenance are shown before confirmation.
- Cross-install import and failed-swap rollback passed with isolated temporary
  installation directories. This is not a live-data recovery exercise or a product
  backup UI. Existing export artifacts are plaintext; no at-rest encryption or
  user acceptance of that risk is claimed.
- Tombstones use the existing 365-day explicit-purge boundary. The Observation
  default is 30 days. No lifecycle scheduler or automatic extension is added.
- Real Provider E2E remains the formal Work Mode enablement gate and is not
  evidence for Agent Memory.
- Phase 3C must decide whether to add a memory browser, cross-install backup UI and
  its plaintext confirmation, project ownership enforcement beyond the current
  single-user Workspace, and further consumers. No automatic Chat Memory mirroring,
  Recall, Consolidation, or Memory Exchange is admitted by this phase.
