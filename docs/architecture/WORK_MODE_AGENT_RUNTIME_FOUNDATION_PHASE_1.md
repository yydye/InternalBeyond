# Work Mode / Agent Runtime Foundation · Phase 1

Status: Home Node Work Run Authority
Date: 2026-10-09

## 1. Scope

The first Work Mode vertical use case is **project.audit.readonly**. Phase 1
adds only durable run identity, state, optimistic concurrency, cancellation
intent, and append-only state events. It does not execute an audit, call a
model, invoke a tool, assemble a prompt, or add a Work Mode UI.

The browser client is a transport adapter over the existing Home Node client.
Home Node remains the only persistence authority. The run ledger lives in the
existing Home Node database file. Its schema version is tracked by
meta[work_runs_schema_version]. It does not add an IndexedDB store or a second
database file.

## 2. Frozen Workflow Contract

The only accepted workflow is **project.audit.readonly**. Creation accepts
exactly these fields:

- requestId: opaque idempotency key
- workflowId: project.audit.readonly
- projectRef: opaque project identifier

projectRef is a bounded reference, never a path or project content. The request
has no prompt, messages, provider, credential, tool arguments, output, or
arbitrary metadata fields. The Home Node rejects unknown fields.

## 3. State Machine

Initial state is queued at version 1. Accepted state changes increment version
once and insert an Event whose sequence equals that version, in the same
BEGIN IMMEDIATE transaction.

| Current | Next | Reason code |
|---|---|---|
| queued | running | runtime_started |
| queued | failed | runtime_failed |
| queued | cancelled | user_cancelled |
| running | completed | runtime_completed |
| running | failed | runtime_failed |
| running | cancel_requested | user_cancelled |
| cancel_requested | cancelled | runtime_cancelled |
| cancel_requested | failed | runtime_failed |

Terminal states are completed, failed, and cancelled. A repeated cancel request
while cancel_requested is a no-op. Cancelling a terminal run returns
run-terminal. Phase 1 persists state only; the future Runtime Shell must
observe cancel_requested and acknowledge it.

Callers supply expectedVersion; mismatch returns version-conflict with the
current allowlisted run projection. Illegal edges or reason codes return
invalid-transition.

requestId is used only for idempotency. The ledger persists SHA-256 digests of
the operation key and normalized request, never the caller's raw key. Repeating
an identical operation produces no new event; reusing the key with a different
operation payload returns idempotency-conflict.

## 4. Private API

All paths are under the existing desktop-only /internal/ surface and use Home
Node's existing desktop credential and _request transport:

| Method | Path | Contract |
|---|---|---|
| POST | /internal/work/runs | Create the fixed workflow |
| GET | /internal/work/runs/active?limit= | Phase 2 bounded active-run recovery query (maximum 100) |
| GET | /internal/work/runs/:runId | Read the allowlisted current projection |
| GET | /internal/work/runs/:runId/events?afterSequence=&limit= | Read bounded append-only Events |
| POST | /internal/work/runs/:runId/transition | CAS transition with requestId, expectedVersion, status, reasonCode |
| POST | /internal/work/runs/:runId/cancel | Cancel queued run or request cancellation of a running run |

The route is not part of /mobile/v1/*. Non-loopback access inherits the
existing desktop-token gate for /internal/*. Loopback access follows Home
Node's existing local single-user policy, including its tokenless mode when no
desktop token is configured. Phase 1 introduces no token, cookie, resolver, or
credential source of its own.

Run projection fields are limited to runId, workflowId, projectRef, status,
version, createdAt, and updatedAt. Event fields are limited to sequence,
eventType, fromStatus, toStatus, version, reasonCode, and createdAt. No prompt,
message, API key, provider settings, raw tool arguments, filesystem path,
artifact, stdout, or exception text is persisted or returned.

Phase 2 adds the `runtime_interrupted` reason only for startup recovery edges:
queued/running -> failed and cancel_requested -> cancelled. It does not add a
new state or permit automatic resume; see the Phase 2 architecture record.

## 5. Runtime Shell / Prompt Runtime

These are Phase 2 logical boundaries, not Phase 1 modules.

| Boundary | Owns | Must not own |
|---|---|---|
| Runtime Shell | Work Mode run loop, orchestration of model turns, cancellation, status transitions and bounded Event reads through Home Node | SQLite, durable run state, Provider catalog, credentials, domain writers, generic scheduler, Chat delivery |
| Prompt Runtime | Ephemeral prompt assembly from the fixed project-audit task, selected project facts, Middle Brain output, and the fixed allowlisted capability contract | Persistent prompt/history storage, secret resolution, direct Memory database access, provider invocation, tool execution, Chat/Role prompt mutation |

The Prompt Runtime is transient. Its output is supplied to the existing model
execution port by the Runtime Shell; it is not stored in the ledger. Middle
Brain may select/compress supplied context and propose/review plans, but cannot
invoke a Work Mode tool. Agent Memory and Memory Exchange are out of scope.

## 6. P28 Relationship

P28's frozen Shape D still governs existing Chat, Group, Moments, Diary, Active
Message, and Role Letter runtimes. IB.runtime remains the shared single-model
execution seam. Phase 1 does not load agent-orchestration-core, add an Event
Bus, add a general Agent Runtime entry point, change legacy schedules, or
transfer any domain authority.

This is a narrow Work Mode exception to P28-1 section 24: Home Node may own the
work_runs, work_run_events, and work_run_idempotency tables for the explicit
project.audit.readonly workflow. These are Home Node domain facts, not an Agent
Runtime store. The prohibition on browser Agent, session, plan, wake, or queue
stores remains; InternalBeyondDB stays at version 24. The exception does not
authorize Phase 2 execution or any other workflow.

## 7. Phase 2 Entry Conditions

Phase 2 may add a Runtime Shell only after it has one reviewed, read-only
project-audit path using the Home Node API, an ephemeral Prompt Runtime, the
existing Provider/credential path, and a single explicitly authorized
read-only project capability. It must retain this state machine and CAS
contract, define restart reconciliation for running and cancel_requested, and
prove that no Chat, Role, Memory, or Vault mutation path was added.

The scoped Phase 2 implementation is recorded in
docs/architecture/WORK_MODE_AGENT_RUNTIME_FOUNDATION_PHASE_2.md. Its provider
path is Mock-verified only; live credentialed invocation remains unverified.
