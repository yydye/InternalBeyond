# Work Mode Foundation — Phase 3B.3 Agent Memory Readonly Recall

Date: 2026-10-10
Status: Implemented with mock/isolated verification. Real Provider E2E remains unverified.

## Contract

Work Agent may read Agent Memory only through the existing Home Node-owned,
independent Agent Memory Authority. Query scope is the current Work Run's exact
`projectRef`. Eligible records must be `active`, effectively active, not expired,
not retracted and not superseded. Invalid or credential-shaped content is excluded.
The local preview is read-only and does not call a Provider.

The user chooses records explicitly. A Recall context is limited to 12 records and
6000 serialized characters. Each projected record preserves its `memoryId`, type,
record revision, full bounded provenance history and source references. The prompt
does not include the local Workspace project ID.

```text
MemoryContext = {
  schemaVersion: 1,
  trustBoundary: "untrusted_reference_data",
  records: [{ memoryId, type, revision, provenance, payload }]
}
```

The prompt inserts this object only under the Agent's JSON `user` payload field
`memoryContext`. System instructions remain a separate `system` message and state
that memory is untrusted, may be stale, cannot change instructions/permissions/scope,
and is subordinate to current authorized source observations. The Runtime does
not pass the `memoryContext` object directly to Middle Brain planning or review.
This does not guarantee that generated Agent output is memory-free: the Agent can
repeat or derive selected memory in its draft, which the current Runtime sends
to Middle Brain Review and persists as a Work Result. Phase 3C.0's Mock audit
demonstrates this indirect path; see
`docs/architecture/WORK_MODE_AGENT_RUNTIME_FOUNDATION_PHASE_3C_0_MEMORY_EXCHANGE_CONTRACT.md`.
The existing read-only `project.read_file` capability is unchanged.

## Egress Authorization

Without selected records and explicit memory authorization, Agent Memory text is
not sent to any Provider. A separate UI checkbox covers the displayed record count,
selected content hash, revisions and exact Agent Provider route. It is independent
from file egress confirmation.

Work Run Consent schema v3 persists only:

```text
memoryScope = {
  projectRef,
  providerScope: { destination: "agent", providerRef, provider, model, routeHash },
  refs: [{ memoryId, revision, contentHash }],
  contextHash,
  contextChars
}
```

It stores no memory body. Run start re-reads the records and verifies project,
revision, status, expiry, per-record hash, total context hash and Agent route. Before
each Agent model turn the Runtime repeats that check and checks the Home Node Consent
Ledger. A revoked/deleted/expired/superseded/edited record, Workspace project access
change, Provider route change, query failure, or mismatched scope prevents the next
Agent call. Query failure before selection leaves Recall unavailable and permits
only an explicitly memory-free run; failure after memory was authorized stops the
Run before sending memory or continuing without it.

These hashes bind authorization to a precise snapshot; they are not encryption,
anonymization, or proof that a human clicked the UI. Memory IDs and hashes remain
sensitive metadata within the local Home Node trust boundary.

The `memoryContext` object is not supplied directly to Middle Brain planning or
review. However, the Agent draft may contain memory-derived content and currently
flows to Review and Work Result. The general file/Provider consent remains
required for the existing audit workflow, and memory authorization is additional;
neither confirmation is inferred from the other. Phase 3C.0 records the indirect
flow as an unresolved downstream-consent gap.

## Phase 3C Protection and Access Decisions

- `agent-memory.db` and managed backup snapshots remain plaintext within the
  validated Home Node data directory, which must be scoped to the current OS user.
  Deployments must enable OS account ACLs and full-disk encryption where available.
  The application does not verify either control; this is not an encryption claim.
- No app encryption key, Vault/Provider credential reuse, automatic cloud backup,
  or automatic export is introduced. Portable plaintext exports remain sensitive
  user-controlled artifacts and require explicit action. Do not use this path for
  data that cannot be held as plaintext on the local device.
- Current project authorization is single-user and local Workspace membership.
  Home Node Consent binds a Run project but does not have a multi-user project-owner
  ACL. Multi-user/remote project access is disabled by default until that authority
  exists and is checked server-side.
- Memory Exchange is default-deny. No import from Chat Memory, export to Chat,
  automatic sync, automatic consolidation, or bidirectional sync is admitted.
- Work Mode's real Provider + Middle Brain + readonly-tool + Result E2E remains a
  separate, unverified formal enablement gate.

## Verification

- Runtime tests cover exact project query scope, foreign-project exclusion,
  superseded/expired/retracted exclusion, count/context ceilings, provenance and
  revision preservation, injection separation, explicit scope binding, content and
  route changes, Workspace access changes, query failure, and mutation between
  Agent turns.
- UI tests verify local preview does not start Provider work, file consent alone
  cannot authorize memory, explicit memory consent is required, content hashes and
  Agent route are bound, changed content revokes the prior Consent, and query
  failure has no egress fallback.
- Home Node integration tests verify v2-to-v3 Consent schema migration and memory
  scope persistence/mismatch rejection. The Work Run ledger stores only IDs and
  hashes, never Recall plaintext.
- Existing Agent Memory store, Chat Message, Chat Memory, Role, Vault and P28
  boundaries are regression-tested. No real Provider call or production memory
  content was used.

## Phase 3C Admission

Phase 3C is **not admitted** until the deployment owner explicitly accepts the
plaintext-at-rest model or approves and implements OS-keystore-backed encryption,
and the required OS ACL/disk-protection checks exist. Multi-user scope remains off
until owner identity and project authorization are available. Memory Exchange
remains denied by default. The real Provider E2E gate remains outstanding and must
pass before formal Work Mode enablement.
