# Work Mode Foundation — Phase 3C.0.1 Memory-Derived Data Closure

Date: 2026-10-10
Status: Implemented with Mock and isolated Home Node verification. No real Provider
call, live project, or Chat Memory operation was used.

## Closure Contract

When a Work Run Consent contains a non-null Agent `memoryScope`, the Runtime
conservatively classifies the **entire generated report draft** as
`memory_derived`, including revisions and content that appears not to quote a
memory literally. This classification is decided by the Runtime/Consent Ledger,
not by model output or a caller-supplied boolean.

Before Review, the Runtime rechecks the current Home Node run, current selected
memory snapshot, current Middle Brain Provider route fingerprint, and the saved
Review sink authorization. The Work Mode Middle Brain port repeats the check at
its transport `beforeSend`, using the actual provider/model/endpoint route and the
fixed `middle_brain_review` consumer. Plan remains a separate `middle_brain_plan`
consumer; it receives no Agent Memory content.

The Review input now includes a non-secret `dataClassification` field with value
`memory_derived` or `project_only`. If memory was selected, both Review and every
retry receive `memory_derived`.

## Home Node Consent Ledger

The existing Work Run Consent Ledger is extended; no new permission authority is
introduced. Home Node Work Run schema version is 4 and the consent terms version
is `work-mode-egress-result-memory-derived-v4`. The additive migration adds:

- `memory_derived_scope_json` to Consent metadata. It stores no memory or report
  body, only project/context hash, exact Review Provider route, and separate
  affirmative Review and Result sink confirmations.
- `memory_derived` and `memory_context_hash` to Work Result metadata. Home Node
  derives them from the stored Consent's `memoryScope`, not request input. Result
  indexes remain metadata-only.

For a memory-enabled consent, the scope must bind the same project and memory
context hash, the exact Middle Brain Review route, and a separately confirmed
Work Result sink with fixed artifact schema, plaintext SQLite storage label, and
the existing 90-day retention. The UI displays independent checkboxes for:

1. Sending the complete potentially memory-derived report to the displayed Review
   Provider route.
2. Persisting the complete memory-derived Result in plaintext Home Node SQLite,
   including retention and logical-deletion residue risks.

The existing general local-storage risk checkbox remains false by default and is
still required. It does not imply the separate derived-Result checkbox. Route,
project, selected memory revision/hash, consent terms, or scope changes invalidate
the matching confirmation and revoke an already-issued Consent. A missing or
stale confirmation fails closed.

`completeRun` independently derives whether the Result is memory-derived and
requires the persisted, active, confirmed Result sink scope inside the same
Home Node transaction that stores the artifact and changes Run status. Caller
fields cannot downgrade the classification. Revoke, expiry, cancellation, CAS
conflict, malformed scope, or a missing confirmation leaves no Result row.

## Revocation and Routing

- Runtime performs a Review-sink precheck immediately before entering Review and
  resolves the route again. A changed route fails before `cognition.review` is
  called.
- The Middle Brain transport resolves its live route again at `beforeSend` and
  checks the same Home Node Consent Ledger. Revocation or a route change between
  Runtime precheck and actual send is denied at transport.
- After Review, cancellation/revocation is checked again through Run state and
  active Consent in Home Node `completeRun`. Cancellation cannot persist a
  reviewed draft.
- A model-controlled or caller-supplied `memoryDerived: false` marker is ignored
  or rejected. When the Run consent includes memory, all reports from it are
  derived by definition.
- Provider egress already in flight cannot be recalled. Consent revocation blocks
  subsequent transmissions and Result persistence; it is not a remote-delete
  mechanism for content already sent externally.

## Verification

Focused tests verify schema v2→v4 migration, Consent scope persistence without
memory text, wrong route/project/file denial, review-sink route checks, revoked
derived Result persistence denial, Result classification across reopen and list
reads, and caller attempt to submit `memoryDerived: false`.

Work Mode Mock tests verify direct grant without both derived scopes is denied,
whole-draft classification, Review transport checks on every retry, review-route
changes, Consent revocation before Review, cancellation after Review, and result
sink tampering/bypass rejection. UI tests verify independent sink checks, route
change invalidation, explicit storage-risk gating, revocation, and default-off
confirmations.

Passed commands:

- `node tests/test_home_node_work_runs.js`
- `node tests/test_home_node_work_runs_client.js`
- `node tests/test_work_mode_middle_brain.js`
- `node tests/test_work_mode_consent_ui.js`
- `node tests/test_work_mode_runtime.js`
- `node tests/test_frontend_structure.js`
- `node tests/test_p28_1_runtime_boundary_freeze.js`
- `node tests/test_chat_core_contract.js` (91 checks)
- `node tests/test_memory_authority.js` (82 checks)

No real Provider was called. No Chat Memory, Role, Credential/Vault, Agent Memory
records, or cross-domain storage contents were modified by this phase's tests.

## Remaining Risk and Phase 3C.1 Admission

The explicit checkbox authorizes this Run's exact sink; it is not encryption, OS
protection, or evidence that a user accepted the product's overall plaintext
storage model. The existing plaintext-risk acceptance state remains **unconfirmed**.
Agent Memory databases/backups and Work Results remain plaintext, deletion remains
logical, and no static encryption is claimed. Real Provider E2E remains
**BLOCKED / NOT VERIFIED**.

Phase 3C.1 may proceed with contract design and isolated Mock/temp-database work.
Production cross-domain persistence/publish remains **BLOCKED** until the owner
explicitly resolves plaintext data protection. Formal Work Mode enablement still
requires its separate real Provider E2E gate. Chat Memory, Role, Agent tools,
automatic memory writes, and production Memory Exchange are unchanged.
