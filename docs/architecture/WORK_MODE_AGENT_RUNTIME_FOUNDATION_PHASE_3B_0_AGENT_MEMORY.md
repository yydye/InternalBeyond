# Work Mode Foundation — Phase 3B.0 Independent Agent Memory

Date: 2026-10-10
Status: Foundation contract admitted; implementation is isolated and opt-in.

## Admission Contract Amendment

P28 §35 changes only the phase dependency:

- A real Provider + Middle Brain + readonly-tool + persisted-Result E2E remains a
  mandatory **Work Mode product enablement** gate. It remains unverified; Phase
  3B.0 does not imply or claim it passed.
- That E2E no longer blocks development of the independent Agent Memory storage
  foundation. This phase admits only Home Node-owned persistence and explicit
  CRUD/query APIs. No Runtime is connected to it.

## Authority and Isolation

- Home Node owns `agent-memory.db` at the existing validated Home Node data
  directory. It is physically separate from `home-node.db` and opened through its
  own SQLite connection, schema, indexes, transactions, revisions, and lifecycle.
- The new store does not import, query, migrate, mirror, or reuse
  `services/home-node/memory-store.js`, `memory_records`, Chat Memory revisions,
  Chat Memory change-log, browser IndexedDB indexes, or recall code.
- The only writer/reader added in this phase is the authenticated desktop
  `/internal/agent-memory` API and its closed Home Node client facade. No Chat,
  Role, Middle Brain, Work Agent, Runtime Recall, automation, or scheduler consumer
  is wired. No automatic import, synchronization, or cross-runtime write exists.
- Agent Memory store-open failure degrades only this API to unavailable; it does
  not prevent Chat or the existing Home Node stores from opening.
- Existing manual Chat JSON export contains IndexedDB data only. Existing
  `home-node.db` backup contains that SQLite file only. Neither includes
  `agent-memory.db`; the new database has no automatic backup/export in Phase 3B.0.
  This omission is deliberate isolation, not a claim of backup coverage. A dedicated
  opt-in backup/export policy is a Phase 3B.1 decision.

## Record Contract

The only record types are `Project`, `Decision`, `Fact`, `Observation`, and
`Procedure`. Each stored record has:

```text
memoryId, type, projectRef?, status, revision, payload, provenance[],
createdAt, updatedAt, supersededBy?, retractedAt?
```

`projectRef` is an opaque local identifier, never a path. Payloads are closed
type-specific objects:

| Type | Payload |
| --- | --- |
| Project | `name`, optional `summary` |
| Decision | `statement`, optional `rationale` |
| Fact | `statement`, optional closed `confidence`, optional `observedAt` |
| Observation | `statement`, optional `observedAt`, optional opaque `contextRef` |
| Procedure | `name`, non-empty bounded `steps[]`, optional `whenToUse` |

Unknown fields are rejected rather than round-tripped. Provenance entries contain
only a closed `sourceKind`, optional opaque `sourceRef`, and server-recorded time;
they do not store prompt text, document content, credentials, or a model transcript.
Provenance is append-only across revisions.

## CRUD, Revision, and Lifecycle

- Create assigns a new `am_...` identity and starts at record revision 1.
- Read is by exact record ID. Query filters are explicit (`type`, `projectRef`,
  `status`) and bounded to at most 100 rows. Default query status is `active`;
  there is no full-text/vector index and no implicit recall path.
- Update replaces the closed payload for an active record only. It requires
  `expectedRevision`; success increments revision and appends provenance. A stale
  revision returns `VERSION_CONFLICT` and the current safe record projection.
- Supersede is one SQLite transaction: CAS the old active revision, create a new
  active same-type/same-project record, and mark the old record `superseded` with
  `supersededBy`. Any transaction failure rolls the whole operation back.
- Retraction is a one-way CAS transition to `retracted`; it increments revision,
  clears `payload_json` immediately, stores a closed reason code, and keeps a
  tombstone/provenance record.
- There is no physical DELETE route. Active records do not expire automatically.
  Explicit bounded cleanup may physically purge only `superseded` or `retracted`
  records older than 365 days. No cleanup scheduler is introduced.

## Sensitive Information and Storage Limits

Write validation is closed by type and field, bounded by payload size, and rejects
common credential/private-key patterns. It is defense in depth, not a guarantee
that arbitrary personal or confidential prose is safe to store. Callers must not
write raw prompts, full transcripts, source files, Provider credentials, or secret
material. The database is plaintext at rest in Phase 3B.0; no encryption or secure
physical erasure is claimed.

## Verification Plan

Focused tests must prove independent file/table boundaries, Chat export/backup
exclusion, no automatic consumers, private API authentication, closed payload
validation, all five types, provenance append, query bounds, revision conflicts,
supersede/retract behavior, retracted payload clearing, restart persistence,
transaction rollback, sensitive-pattern rejection, and cleanup eligibility. Real
Provider validation remains a separate Work Mode enablement gate and is not a test
precondition for this phase.
