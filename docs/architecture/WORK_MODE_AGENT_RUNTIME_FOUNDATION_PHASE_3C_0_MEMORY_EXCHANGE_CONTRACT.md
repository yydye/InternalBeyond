# Work Mode Foundation — Phase 3C.0 Memory Exchange Contract

Date: 2026-10-10
Status: Contract frozen for review; Mock audit only. No production Exchange API or
Chat Memory ↔ Agent Memory flow is connected.

## Admission and Non-Goals

This phase admits contract design and isolated Mock validation only. It does not
admit direct cross-database access, automatic sync, cross-domain writes, new
provider routing, or an Exchange storage authority. The existing Work Agent
readonly Recall from Phase 3B.3 remains a separate, consent-gated Agent Memory
consumer; this document does not broaden that permission.

The plaintext-at-rest risk acceptance remains **unconfirmed**. The real Provider
+ Middle Brain + readonly-tool + persisted-Result E2E remains **BLOCKED / NOT
VERIFIED** and is still required for formal Work Mode enablement. Neither status is
changed by this contract.

## Authority Audit

| Domain | Current authority and boundary | Exchange consequence |
| --- | --- | --- |
| Chat Memory | `services/home-node/memory-store.js` is the canonical Home Node store in `home-node.db`; Chat messages are separately owned by `chat-store.js`. Browser Memory Authority uses the Home Node client/API, with browser state only a mirror/fallback. `/memory/*` is desktop-only; the mobile gateway does not expose `/mobile/v1/memory`. | Exchange must call the existing Memory Authority contract. It must not query `memory_records` directly, treat `owner_id` as permission, or use a browser mirror as proof of access. |
| Chat Memory access | `assets/js/memory-visibility-core.js` is the canonical `canReadMemory` predicate. It requires an explicit role principal; `private`, missing, malformed, unknown and non-visible records fail closed. `only` / `except` are role-visibility rules, not project ACLs. The current predicate does not grant an owner bypass for `private`. | A source read must be authorized by the Chat Memory Authority for the actual principal. Exchange cannot translate visibility into project access or bypass a denied source read. An explicit owner-export capability does not currently exist; denied records stay ineligible. |
| Agent Memory | `services/home-node/agent-memory-store.js` owns the independent `agent-memory.db`, schema, revisions, provenance, query, backup and lifecycle. The private `/internal/agent-memory` surface and `createAgentMemoryRemote` are its client path. Project authorization is supplied by the local Workspace/Work Mode boundary; the store itself is not a multi-user ACL. | Exchange must use Agent Memory Authority methods and recheck local Workspace access. It must not attach to `home-node.db`, Chat indexes, or infer a project grant from a record's existence. |
| Exchange | No Memory Exchange API, exchange ledger, cross-domain record query, or automatic sync exists. | Phase 3C.1 may add a narrow Home Node coordinator, not another record store, credential resolver, Provider authority, or generic event bus. |

Relevant source evidence: `assets/js/memory-authority.js`,
`assets/js/home-node-client.js` (`createMemoryRemote` and
`createAgentMemoryRemote`), `services/home-node/mobile-gateway.js`,
`services/home-node/http.js`, `services/home-node/memory-store.js`,
`services/home-node/agent-memory-store.js`, and
`services/home-node/work-run-store.js`.

## Three Operations

All operations are single-user, local-Home-Node actions. No operation implies
another. Each binds exact source revision/content hash, purpose, target, and expiry;
hashes bind the review snapshot but are not encryption, anonymization, or DLP.

| Operation | Contract | Persistence |
| --- | --- | --- |
| **Temporary Reference** | Read-only, short-lived reference to an explicitly selected source record or field. Scope binds source domain/id/revision/hash, requesting runtime, target project or conversation, purpose, and (if any) exact Provider/model/route. Each use re-reads the source Authority and rechecks access. Provider egress requires a separate explicit, route-specific confirmation; local preview alone never authorizes egress. | No target record is created. Reference body/token is volatile and expires within 5 minutes; restart invalidates it. Revocation blocks future use, not data already sent to a Provider. |
| **Import Proposal** | Target-side typed preview generated from a Temporary Reference. It names the exact destination record type/class, selected fields, visibility/scope, provenance, transform version, and expected destination revision. Unsupported fields/types are rejected or shown as omitted; they are never guessed. Source revision/access and destination project/scope are rechecked at acceptance. | Proposal is not a write. Proposal body is not persisted by Exchange; it expires within 15 minutes and is invalid after restart, source change/revocation, target change, or permission failure. |
| **Explicit Publish** | One-shot user-confirmed publication of the exact reviewed proposal to one named target scope. The confirmation names content hash, source, destination, purpose, visibility/recipients, expiry/lifecycle, and any Provider route. Home Node delegates the create/update to the target Memory Authority with idempotency and target CAS where applicable. No bulk publish, implicit audience widening, or persistent grant is allowed. | A single target-authority mutation creates a copy with Exchange provenance. An identical retry returns the same receipt; a reused idempotency key with different content/scope is rejected. A publish is not a live link or sync subscription. |

Initial API shape (proposed; not implemented): a desktop-private Home Node
`/internal/memory-exchange` surface with `createReference`, `revokeReference`,
`createProposal`, `getProposal`, and `publish`. The Exchange coordinator calls
domain Authority interfaces; it contains no SQL for either memory database and
stores no memory body. Reference/proposal state may be volatile. The durable
receipt/provenance belongs to the destination record through its existing
Authority. Do not add an Exchange database merely to cache records. If future
receipt discovery requires an index, it must contain metadata only and needs a
separate backup/retention/privacy review first.

Frozen request/response shape (field names are normative; transport wrapping may
follow the existing Home Node envelope):

```text
SourceRef = {
  domain: "chat" | "agent",
  recordId,
  revision,
  contentHash,
  projectRef?                 // required for Agent Memory
}
TargetScope = {
  domain: "chat" | "agent" | "agent_runtime" | "middle_brain" | "work_result",
  scopeRef,                    // current local project/conversation/run/artifact
  recordType?,                 // target-specific; never inferred from source
  visibility?, recipients?     // Chat-only; must be explicit for a widening
}
// Import Proposal and Explicit Publish require target.domain in {"chat", "agent"}.
// Runtime/Review/Result scopes are Temporary Reference or egress-consent targets only.

createReference({ requestId, source, target, purpose, selectedFields, expiresInMs })
  -> { referenceId, source, target, selectedFields, preview, previewHash, expiresAt }
revokeReference({ referenceId, requestId })
  -> { revoked: true }
createProposal({ requestId, referenceId, target, transformVersion, mapping })
  -> { proposalId, source, target, preview, previewHash, expectedTargetRevision, expiresAt }
getProposal({ proposalId })
  -> same preview only while still valid
publish({ proposalId, requestId, confirmed: true, termsVersion, previewHash,
          expectedTargetRevision })
  -> { exchangeId, sourceRef, targetRef, targetRevision, publishedAt }
```

The API rejects caller-supplied source bodies, credentials, prompts, generated
tool/model output, arbitrary routes, and undeclared fields. It derives `preview`
by rereading the named source through its Authority. The preview is held only in
volatile UI/runtime memory; the Exchange service does not durably store it.
`publish` accepts only the exact, unexpired `previewHash` and the same source and
target scope reviewed by the user. Phase 3C.1 initially creates one new target
record only (`expectedTargetRevision: null`); target edits/replacements are
deferred until their Authority contract supports CAS. Egress to `agent_runtime`,
`middle_brain`, or `work_result` is not a Memory Publish and needs separate sink
authorization described below.

Every mutation requires an exact request schema, a one-use confirmation bound to
the preview hash and destination, a request idempotency key, and target CAS for
updates. Reads and writes fail closed on source/target Authority errors, missing
principal/project access, stale revision/hash, expired/revoked authorization,
unsupported mapping, changed route, or partial target failure. Logs contain
operation IDs and reason codes only, never memory text, prompts, raw tool/model
payloads, or credentials.

## Bidirectional Classification and Mapping

Classification is evaluated independently at source and destination. A source
classification never silently becomes a destination permission.

| Direction | Source eligibility | Destination classification and mapping |
| --- | --- | --- |
| Chat Memory → Agent Memory | Use the canonical Chat read predicate for the current principal and current record. `public` is only the existing Chat visibility meaning; it is not automatic permission to persist into Agent Memory. `only` / `except` must pass the exact principal check. `private`, missing, malformed, unknown, or unreadable records are denied; there is no owner bypass. | User chooses one Agent Memory type and current Workspace project. Chat `class`, visibility, `owner_id`, and free-form fields do not map automatically to Agent type or `projectRef`. Preview the selected text/provenance and a typed transform. Default proposed type is `Observation` with the existing 30-day expiry; any different type/expiry needs explicit review. Agent provenance must identify the Chat source and Exchange operation; current Agent `SOURCE_KINDS` has no dedicated Exchange source kind, so 3C.1 must add and validate one before accepting writes. |
| Agent Memory → Chat Memory | Read only through Agent Memory Authority, for the exact currently accessible Workspace project and an active, unexpired, unretracted, unsuperseded record. Do not infer a grant from a projectRef in caller input. | User chooses the Chat destination class, visibility, and recipients. Agent `projectRef` is lineage, not a Chat ACL or `owner_id`. Default visibility is `private`; publication to `public`, `only`, or `except` is a visible scope change and requires explicit recipient/scope confirmation. Chat provenance must retain Agent source id, revision, project reference, and Exchange id without copying Agent records into Chat indexes. |

The two schemas are not isomorphic. The proposal must display the exact resulting
fields before confirmation; unknown fields are omitted only with disclosure, and
an unsupported required field rejects the proposal. No merge-by-similarity,
overwrite, implicit supersede, or bulk conversion is part of 3C.1. First publish
implementation should create one new destination record; editing/replacing an
existing record is deferred unless its target Authority supports and enforces CAS.

## Provenance, Authorization, and Lifecycle

The destination-authority provenance receipt must include at minimum:

```text
exchangeId, sourceDomain, sourceRecordId, sourceRevision, sourceContentHash,
sourceProjectRef?, selectedFields, transformVersion, targetDomain,
targetRecordId, targetScope, purpose, actor=local_user, confirmedAt,
authorizationExpiry, termsVersion
```

`local_user` is a single-user local trust label, not a cryptographically verified
human identity. Do not store source or target bodies in the receipt. Existing
Agent provenance validation must be deliberately extended for an Exchange source;
Chat arbitrary-payload round-tripping does not itself establish Exchange
authorization or provenance correctness.

- The Temporary Reference expires after at most 5 minutes; each resolution checks
  current source revision and access. Revoking it invalidates the capability.
- An Import Proposal expires after at most 15 minutes. Source mutation/revision,
  access change, project membership change, destination-scope change, or restart
  invalidates it. Rebuild and re-preview; never silently refresh a user's consent.
- Explicit Publish is one-use and one-target. Authorization expiry prevents future
  operations but does not retract a completed copy or recall content already sent
  externally.
- Source retract/supersede/expiry makes future references/proposals fail. A
  completed destination copy remains an independent record. On explicit
  revalidation, Exchange reports `source_invalidated`; it does not silently edit
  or delete the target. Removing a published copy requires a separate user
  confirmation and target-Authority retract/delete with expected revision. This
  is invalidation visibility, not automatic bidirectional sync.
- Revoke and cleanup actions are idempotent and auditable by IDs/reason/time. No
  background sync, reconciliation, or automatic delete is admitted.

Provider permission is separate from Memory Exchange permission. If selected
memory is sent to a Provider, authorization binds the exact records/revisions/hash,
purpose and Provider/model/route. If memory can influence generated output, all
downstream sinks must be considered tainted: later Provider Review and persistent
Work Result are separate sinks requiring explicit authorization. Consent to send
memory to the Agent Provider does not authorize either sink.

## Indirect Egress Audit

The existing Phase 3B.3 Agent Runtime injects selected Agent Memory only into the
Agent's user payload and does not pass the memory body to Middle Brain planning.
However, the result path has an indirect disclosure/persistence gap:

1. The Agent can copy or derive selected memory into `draft.summary` or a finding.
2. `assets/js/work-mode-runtime.js` serializes that draft as `reportText` and sends
   it to `cognition.review` with the Middle Brain Review authorization. The
   memory-specific scope is not attached to that route.
3. If Review approves, the same draft is persisted by `homeNode.complete` as a
   Work Result.

The test `testMockAuditsIndirectMemoryFlowToReviewAndWorkResult` injects a
synthetic sentinel into a selected memory record and confirms that a Mock Agent
can return it, that Middle Brain Review receives it, and that the Work Result
stores it. It also confirms the current memory scope covers only the Agent route.
This is a deliberately synthetic boundary test, not a Provider call or evidence
from user data. No production code was changed in 3C.0. Because generated output
cannot be reliably proven free of memory-derived information, 3C.1 must either
default-deny memory-enabled runs whose sinks are not separately authorized, or
extend consent/UI to bind the Agent route, exact Middle Brain Review route, and
Work Result persistence as distinct sinks. Treat the whole generated draft as
memory-derived whenever Recall was supplied; string scanning is not an adequate
control.

## Phase 3C.1 Minimum Scope

1. Add only the Home Node Exchange coordinator/API and Authority adapters. No
   direct SQLite joins or second Provider, Credential, Memory, or Tool authority.
2. Implement the one-record Temporary Reference → Import Proposal → explicit
   Publish path. References/proposals are volatile; restart invalidates them.
   Publish calls the existing destination Authority and writes source provenance.
3. Add source revision/access revalidation, target project/scope checks, one-use
   confirmation, idempotency, CAS, explicit revoke/retract, expiry, and fail-closed
   error behavior. Multi-user access remains disabled.
4. Add a minimal preview/confirmation surface only if required to present source,
   exact fields, destination, classification/visibility, purpose, expiry, and
   downstream sinks. No implicit defaults may widen visibility.
5. Close the indirect Work Result / Middle Brain Review path before allowing
   memory-derived content to those sinks. Add Mock tests for all three operations,
   both directions, route/scope changes, retry/CAS, revoke/expiry/restart, source
   invalidation, and no Chat Memory pollution.
6. Keep the plaintext risk acceptance **unconfirmed**. Do not persist new
   cross-domain memory copies in production until that data-protection gate is
   explicitly resolved. Real Provider E2E stays **BLOCKED** and is not part of
   Mock acceptance.

Phase 3C.1 implementation admission is conditional on explicit resolution of the
plaintext storage risk before production publish. Contract tests and isolated
temporary-database tests may proceed without live data. Formal Work Mode
enablement still requires the separate real Provider E2E.

## Mock Verification

- `node tests/test_work_mode_runtime.js` passes, including the sentinel audit for
  indirect Middle Brain Review and Work Result flow.
- Existing `node tests/test_agent_memory_store.js` and
  `node tests/test_chat_core_contract.js` pass, preserving physical Chat/Agent
  store separation and Chat Memory behavior.
- `node tests/test_home_node_work_runs.js` passes, including v2→v3 consent
  migration and rejection of a memory scope attached to a Middle Brain route.
- No production Exchange endpoint, cross-domain write, live record, credential,
  or Provider was used.
