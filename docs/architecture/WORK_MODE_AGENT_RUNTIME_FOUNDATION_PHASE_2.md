# Work Mode / Agent Runtime Foundation · Phase 2

Status: Readonly Agent Loop
Date: 2026-10-09
Workflow: `project.audit.readonly`

## 1. Call Graph

```text
explicit caller
  -> IB.workMode.runtime.start(runId, profileRef)
     -> exclusive Web Lock for this desktop origin
     -> Home Node Work Run API: list active / reconcile stale / CAS queued -> running
     -> Workspace Read-only Tool Adapter: exact projectRef snapshot
     -> IB.workModeCognition.plan (existing Middle Brain transport and credential path)
     -> Prompt Runtime builds transient JSON-only model turn
     -> IB.runtime.instance.resolveModel + execute
        -> existing callApiChat* / Provider mapping / Credential Resolver
           with native tools, autoContinue, and web search disabled
     -> strict turn parser
     -> fixed project.read_file adapter (fileId only, in selected project scope)
     -> transient Observation -> next ModelPort turn
     -> IB.workModeCognition.review (bounded evidence excerpts, existing Middle Brain path)
     -> Home Node CAS running -> completed
```

No call is made by loading the scripts. A caller must explicitly start an
already-created queued Work Run and name an active existing API profile. The
profile reference and all prompts, source observations, drafts, and final
report remain transient in the current page.
The internal Workspace `projectRef` is used for local authorization and is not
included in either Provider's prompt payload.

## 2. Ownership and Contracts

| Domain | Owns | Does not own |
|---|---|---|
| Home Node Work Run Authority | Durable Run status/version, CAS, cancellation intent, append-only state Events | Provider calls, Workspace reads, prompts, model/tool payloads |
| Runtime Shell (`work-mode-runtime.js`) | Exclusive execution ownership, bounded model/tool/review loop, cancellation, state transitions through the Home Node client | SQLite, credentials, Provider mapping, Chat/Role/Memory writes, generic scheduling |
| Prompt Runtime (`work-mode-prompt-runtime.js`) | Transient system/user message assembly and strict JSON turn validation | Network, storage, credentials, direct Workspace access, tool execution |
| Work Mode cognition port (`IB.workModeCognition`) | Middle Brain plan validation and report review using the existing Middle Brain model path | Workspace reads or tool execution; it is separate from the frozen `IB.middleBrain` Chat/Role facade |
| Project Tool Adapter (`work-mode-project-tool.js`) | One fixed `project.read_file` capability, project/file scope checks, text and size bounds, common-secret redaction | Arbitrary path reads, writes, shell, registry, network, or persistence |
| Workspace | Existing local project/file database and exact project/file lookup | Run status or remote provider calls |
| Shared ModelPort | One model turn using existing Provider selection and Credential Resolver via `IB.runtime.instance` | Work Run state, loop policy, native tool execution |

The existing `IB.middleBrain` facade remains at 56 keys. Work Mode plan/review
is an additive workflow-scoped API, not a Chat/Role facade expansion. The shared
`IB.runtime` remains a single-model execution seam; the Work Mode Shell owns the
loop and never enables the existing Chat tool loop.

## 3. State, Cancellation, and Restart

Phase 1 statuses remain unchanged. Phase 2 adds only the `runtime_interrupted`
reason for safe terminalization:

| Active state found under exclusive ownership | Recovery transition | Resume |
|---|---|---|
| queued | failed / `runtime_interrupted` | Never |
| running | failed / `runtime_interrupted` | Never |
| cancel_requested | cancelled / `runtime_interrupted` | Never |

At start, the Runtime holds Web Lock `ib-work-mode-agent-runtime-v1`, reads at
most 100 active runs, and CAS-terminalizes all except the explicitly requested
queued Run. An incomplete page or version conflict fails closed before the new
Run reaches the model. The target Run is claimed by queued -> running CAS; a
second caller cannot claim the same version. A live cancellation through the
Runtime first records `cancel_requested` in Home Node, aborts the in-flight
ModelPort call, then CAS-acknowledges `cancelled`. Future UI must use
`IB.workMode.runtime.cancel`, not only change Home Node state.

The current execution owner assumes the single canonical desktop origin, whose
tabs share Web Locks. Home Node CAS protects one Run even if that assumption is
broken, but stale-run sweeping cannot distinguish a live executor in another
origin from a crashed one. Multi-origin, remote, or independently hosted
Runtime callers are therefore unsupported until Home Node owns an expiring
executor lease/heartbeat contract. That is an explicit Phase 3 gate.

## 4. Persistence and Retention

Persisted Work Run data is still only the Phase 1 projection and state Events.
The current graph allows at most four Events per Run including `created`.
Events are retained indefinitely; there is no automatic pruning. Idempotency
digests and Run rows are also currently unbounded. No prompt, transcript,
observation, source excerpt, raw tool argument, credential, exception text, or
full model output is written to Home Node, browser storage, or logs. The final
sanitized report is returned to the explicit caller only and is lost on page
reload.

The adapter skips common secret-file names and private-key formats and redacts
common credential patterns before provider egress. This is a defense-in-depth
heuristic, not a proof that arbitrary project text contains no secrets; Phase 3
must put provider-egress consent and a result-retention choice in front of any
formal UI. Workspace currently supplies local project identity and file IDs,
not a separate per-project ACL, so Phase 2's authorization scope is exact local
project identity plus the Middle Brain-selected file IDs.

## 5. Verification

The automated vertical test uses Mock ModelPort, Mock Middle Brain, Mock
Workspace, and an in-memory Home Node client. It covers completed audit,
one bounded review revision, model failure, tool failure, cancel/acknowledge,
CAS conflict, interrupted queued/running/cancel_requested states with no
resume, cross-project/file scope denial, shell capability rejection, and
credential redaction. Separate production Home Node integration tests exercise
the real SQLite Work Run store and authenticated HTTP API, including the active
Run query and restart reason. Chat message contract, Role DM, Memory authority,
and Vault regression suites are focused independently.

No live Provider or Middle Brain credential was available to this shell; a
real provider invocation is **not verified**. No Work Mode UI is included.

## 6. Phase 3 Admission

Before a formal Work Mode UI or additional workflow is admitted:

- Perform a controlled live `project.audit.readonly` run with an explicitly selected Workspace project and existing Provider profile; verify Middle Brain plan/review, Provider credential resolution, cancellation, and the redacted report end to end.
- Add an explicit provider-egress consent step and explain that project source leaves the local Workspace for the selected Provider.
- Decide whether results remain ephemeral or define a minimal sanitized result artifact, its Home Node owner, access scope, retention, and deletion semantics. Do not persist the prompt or transcript.
- Add Home Node executor lease/heartbeat before supporting multiple origins, remote callers, or multiple independent app hosts.
- Decide bounded retention/cleanup for Runs and idempotency digests; preserve append-only Events within the chosen audit period.
- Keep Agent Memory, Memory Exchange, Automation, general tool registries, generic Event Bus, and Chat/Role loop changes out until separately admitted.

## 7 Phase 3A Supersession

Phase 3A has since adopted the Work Result Artifact, explicit provider-egress
consent, and retention policy described above as Phase 3 admission work. The
final report is no longer ephemeral for new Phase 3A completions: it is stored
in `work_run_results` under the lifecycle contract in
`docs/architecture/WORK_MODE_AGENT_RUNTIME_FOUNDATION_PHASE_3A.md`. The prompt,
source observations, and provider transcripts remain transient.
