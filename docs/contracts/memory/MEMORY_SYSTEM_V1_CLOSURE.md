# Memory System v1 Engineering Closure

- Audit date: 2026-10-08
- Scope: primary Home Node-backed Desktop and Mobile chat cognition.
- Decision: engineering closure; no Memory feature or runtime implementation is added by this record.

This record is the current cross-phase status authority. Earlier phase contracts and roadmap rows remain append-only historical snapshots; this closure reconciles their current meaning without rewriting those facts.

## A. Authority graph

Home Node SQLite canonical Memory
→ shared visibility / Recall selector
→ Semantic Forgetting projection inside candidate ranking and rendering
→ one-turn Recall snapshot
→ Association
→ Contextual Reinterpretation (K)
→ Self Narrative (L)
→ Meta-Memory (N)
→ Memory Unreliability (O)
→ Shared Memory view (P)
→ Counterfactual view (Q)
→ Behavior Modulation (M)
→ response-guidance-v1
→ Desktop browser provider or Mobile Home Node provider

Independent feedback:

validated Expectation → P2 Prediction Registry
trusted RealityEvent → P1 Observation projection
P2 + sealed P1 → P3 Settlement + Prediction Error
sealed eligible P3 → P4 Calibration ledger

Canonical Memory is the Home Node memory_records authority. The browser IndexedDB memories table is a mirror. Recall selection and ranking use the shared memory-retrieval-core. Semantic Forgetting is a projection inside that selector, not a second Recall owner. The source authority and storage split are recorded in MEMORY.md:43, 60, 69, 85, and 189.

The unique derived-cognition seam is runtime-recall.js#runCurrentMeaningAndNarrative (runtime-recall.js:1052-1074). It consumes the selected Recall snapshot and already-produced projections; it does not rescan the Memory database. Behavior posture is derived immediately after that seam in both existing-recall and authoritative Recall paths (runtime-recall.js:1411-1417 and 2341-2355). One response-guidance-v1 envelope is assembled by the existing Recall owner (runtime-recall.js:2421-2444).

## B. Runtime chain and per-stage contract

| Stage | Owner; input → output | Durability and mutation authority | Failure behavior; Desktop / Mobile |
| --- | --- | --- | --- |
| Canonical Memory | Home Node memory-store; user/consolidation record writes → canonical record and revision | DURABLE in Home Node SQLite. Browser IndexedDB is a mirror. This is the only canonical content authority. | Store read failure yields an empty Memory block. Desktop primary chat calls Home Node; Mobile reads the same Home Node store. |
| Recall + H | shared memory-retrieval-core through memory-recall-orchestrator and Home Node memory-retrieval; visible candidates + current message → selected context, IDs, and per-selected-record H projection | Selection and H projection are DERIVED_ONLY / TURN_ONLY. The selector writes nothing. Separate Recall activation telemetry is explicitly allowed and listed in D. | H projection failure restores original ranking/detail behavior; ACL uncertainty remains fail-closed to no Memory. Both primary hosts use the shared selector. |
| Association | runtime-memory-association; selected IDs plus this Recall cycle’s candidate snapshot → bounded relation edges, tension sets, working set | DERIVED_ONLY; request result is turn-scoped and memo is process/session-only. No canonical, relationship, or P.E. writes. | Failure returns direct Recall. Desktop and Mobile use the same runtime and the same Recall snapshot. |
| K Reinterpretation | runtime-interpretation; selected canonical records, R3 association, current topic, and permitted current context → validated current meaning and trace | DERIVED_ONLY / TURN_ONLY; bounded in-process guards only. Production operator policy is the authority; code-level default is OFF. | Invalid, timed-out, disabled, or missing provider leaves Recall and Association usable. Both hosts run the same Home Node owner when policy and evidence gates allow it. |
| L Self Narrative | runtime-self-narrative; validated K result and provenance → bounded narrative view and revision trace | SESSION_ONLY in an in-process character/conversation holder; not canonical Memory or durable self state. | Reuses prior session narrative or returns no narrative; K and Recall remain. Same owner on both hosts. |
| N Meta-Memory | meta-memory-awareness-core; selected IDs, H availability, K uncertainty, L provenance → ordinal memory-state awareness | DERIVED_ONLY / TURN_ONLY. No provider or durable writer. | Empty awareness guidance; Recall, K, and L remain usable. Same private cognition seam. |
| O Memory Unreliability | memory-unreliability-core; N gate, H projection, existing R3 edges and provenance → structured current recollection and uncertainty guidance | DERIVED_ONLY / TURN_ONLY. No provider or durable writer. | No distortion/reconstruction is emitted; original Recall and N remain. Same private cognition seam. |
| P Shared Memory | shared-memory-core; O recollection, N awareness, user-report and character provenance, verified acknowledgement if assembled → source-separated relation view | DERIVED_ONLY / TURN_ONLY. No side is merged or rewritten. Joint acknowledgement is authority-gated; production acknowledgement authority is not assembled by default. | O/N/Recall continue and no shared fact is created. Same private cognition seam. |
| Q Counterfactual | runtime-counterfactual-memory + Q-specific core; explicit premise, current K/L/N/O/P state, selected records, and optional sealed P1/P3 evidence → one bounded non-factual alternative view | DERIVED_ONLY / TURN_ONLY; replay cache is process/session-only. P.E access is read-only. | No view on missing evidence, invalid projection, or provider failure. Both hosts omit Q and continue with existing context. |
| M Behavior Modulation | runtime-behavior-modulation; current K/L and bounded provenance → ordinal posture in response-guidance-v1 | DERIVED_ONLY / TURN_ONLY; replay cache is process/session-only. It may register external influence through the single BehaviorEffect attribution owner; it does not write Behavior state. | Baseline posture or no guidance. Desktop renders the envelope but consumption is not verifiable; Mobile records consumption only after server-side prompt insertion. |

Prediction Error is a separate Home Node feedback chain, not another Memory writer:

| Substage | Owner; input → output | Durability / mutation authority | Failure fallback; Desktop / Mobile |
| --- | --- | --- | --- |
| P2 Prediction Registry | runtime-prediction-registry; validated Expectation + scope → sealed PredictionRecord and prediction ID | SESSION_ONLY. Sole Prediction ID mint and record owner; no Memory or Relationship write. | Invalid, duplicate, or missing-scope input creates no record. Runs on the shared Home Node for both hosts when an existing producer supplies a valid expectation. |
| RealityEvent / P1 Observation | runtime-reality-event admits trusted canonical or explicit structured-user facts → sealed RealityEvent; runtime-outcome-observation pairs an eligible event with P2 → sealed P1 Observation projection | SESSION_ONLY. Event source authority and observation projection are separate; P1 does not assign support/conflict or settle. | Missing/invalid source or evidence produces no observation. Both hosts use the same server-side authorities; free-text/model inference cannot mint reality. |
| P3 Settlement / Prediction Error | runtime-prediction-settlement; sealed P2 + accepted P1 evidence → sealed SettlementRecord and PredictionErrorRecord | SESSION_ONLY. P3 is the sole settlement and error authority; P.E remains ordinal and does not write Memory. | Insufficient, invalid, or out-of-scope evidence yields no settlement or a non-counted result. Feedback failure does not fail Recall or Chat. Desktop unknown attribution cannot be a clean decisive calibration basis; Mobile prompt consumption is server-verifiable. |
| P4 Calibration | runtime-prediction-calibration-driver passes sealed eligible P3 → runtime-prediction-calibration ledger summary | SESSION_ONLY. P4 owns its bounded ledger; it cannot revise P3 or apply calibration to live behavior. | Invalid/unavailable input is skipped or logged; P3 remains unchanged and chat continues. Same Home Node ledger on both hosts; Desktop/Mobile attribution policy is preserved. |

Implementation anchors:

- Canonical storage and allowed content/activation writes: memory-store.js:512, 572, 604.
- Shared Recall and H: memory-retrieval.js:72, 291, 315; memory-retrieval-core.js:198, 321, 529.
- Association: runtime-recall.js:380; runtime-memory-association.js:65, 380.
- K and L: runtime-recall.js:988, 1017, 1052, 1602; runtime-interpretation.js:1544-1609; runtime-self-narrative.js:275, 517.
- N/O/P/Q: meta-memory-awareness-core.js:170; memory-unreliability-core.js:230; shared-memory-core.js:334; runtime-counterfactual-memory.js:299; runtime-recall.js:1120, 1154, 1233, 1076.
- M and response guidance: runtime-behavior-modulation.js:164, 205; runtime-recall.js:1306, 2421-2444.
- P2/P1/P3/P4: runtime-prediction-registry.js:163, 300; runtime-reality-event.js:204, 334; runtime-outcome-observation.js:374, 607; runtime-prediction-settlement.js:244, 564; runtime-prediction-calibration-driver.js:52; runtime-prediction-calibration.js:205, 415.
- Desktop and Mobile transports: communication.js:1729, 1765, 2165; mobile-gateway.js:994, 1037, 1095.
- Both Home Node composition paths: home-node-service.js:1344-1416 and 1927-1965.

K/L/M are evidence-eligible capabilities, not a promise that every turn with a direct Memory item produces a reinterpretation or non-baseline posture. K/L are skipped when the current Recall has no associated working-memory evidence; M then returns baseline. Q still requires its own explicit premise, remembered anchor, and causal evidence gates. Direct-only Recall remains valid and uses the existing nonblocking R4-C path where enabled (runtime-recall.js:1449-1600 and 1602-1614). This is a bounded eligibility rule, not a second current-meaning authority.

## C. Durability matrix

| Capability/state | Boundary |
| --- | --- |
| Canonical Memory record and content | DURABLE — Home Node SQLite; browser IndexedDB is a replaceable mirror. |
| Recall ranking, selection, H accessibility/detail projection | DERIVED_ONLY / TURN_ONLY — recomputed from current canonical rows and current context. |
| Recall activation count / last activated | DURABLE telemetry — narrow canonical columns only; not content, provenance, or revision. |
| Recall exposure/cooldown session state | SESSION_ONLY. |
| Association edges and memo | TURN_ONLY output; SESSION_ONLY bounded memo. |
| K current interpretation | TURN_ONLY output; no durable interpretation record. |
| L Self Narrative | SESSION_ONLY revisions with bounded TTL/cap; no restart recovery. |
| N Meta-Memory | DERIVED_ONLY / TURN_ONLY. |
| O Reconstructed Recollection | DERIVED_ONLY / TURN_ONLY. |
| P Shared Memory view | DERIVED_ONLY / TURN_ONLY. |
| Q Counterfactual view | DERIVED_ONLY / TURN_ONLY; replay suppression holder is SESSION_ONLY. |
| M Behavior posture | DERIVED_ONLY / TURN_ONLY; replay cache is SESSION_ONLY. |
| P2 Prediction Registry | SESSION_ONLY; bounded process-memory holder, no restart recovery. |
| RealityEvent and P1 Observation projection | SESSION_ONLY identities/holders; underlying source-domain facts retain their own source durability. |
| P3 Settlement and Prediction Error | SESSION_ONLY; sealed, bounded process-memory holder. |
| P4 Calibration ledger | SESSION_ONLY; bounded in-memory partitions and dedupe; no application to live behavior. |

The R4 derivatives and P.E records are not long-term durable capabilities. P2 lifetime is declared at runtime-prediction-registry.js:21-26; P1 at runtime-outcome-observation.js:28 and 607-635; P3 at runtime-prediction-settlement.js:564-585; P4 at runtime-prediction-calibration.js:23-25 and 415-430.

## D. Mutation audit and real writers

| Writer | Actual mutation | Boundary |
| --- | --- | --- |
| memory-store.putRecord / putRecords / deleteRecord | Canonical Memory content create/update and soft-delete | Authorized canonical writer; memory-store.js:512 and 572. Browser writes route through memory-authority and the Home Node record endpoint. |
| memory-store.recordActivation | Durable activationCount / lastActivated telemetry | Authorized Recall telemetry only; memory-store.js:604. It does not rewrite payload_json or advance revision. Called by Home Node retrieval reinforcement and the browser authority endpoint (memory-retrieval.js:271-282; memory-authority.js:336-355). |
| RecallSessionState | Per-session exposure/cooldown bookkeeping | SESSION_ONLY; not canonical content. |
| runtime-self-narrative | Its own bounded session narrative revisions | SESSION_ONLY; no durable Self Narrative authority is written. |
| runtime-prediction-registry | P2 PredictionRecord holder | SESSION_ONLY; sole P2 mint/registration owner. |
| runtime-reality-event and runtime-outcome-observation | Sealed RealityEvent and P1 observation holders | SESSION_ONLY; no Memory write. |
| runtime-prediction-settlement | P3 SettlementRecord and Prediction Error holder | SESSION_ONLY; sole settlement owner. |
| runtime-prediction-calibration-driver → runtime-prediction-calibration | Dispatch of sealed eligible P3 into P4 ledger | P4 owns its session ledger; the driver does not settle or rejudge. |
| runtime-behavior-modulation → runtime-behavior-effect | Session-scoped external-influence attribution registration | Attribution bookkeeping only; not Behavior, Persona, Relationship, Emotion, Memory, or P.E. state. |

The derived cognition stages H, Association, K, L, N, O, P, and Q have zero writes to canonical Memory content, Persona, Relationship, Emotional State, Behavior state, Prediction Error/settlement, and Active Message schedule. L may update only its own bounded session holder, as listed above. Their outputs are private derived values. M’s only side effect is the bounded registration above in the single attribution owner. Active Message scheduling remains owned outside this Memory chain.

Frozen mutation assertions:

- DERIVED_MODULE_CANONICAL_MEMORY_WRITES = 0
- CANONICAL_MEMORY_DELETES_FROM_FORGETTING = 0
- CANONICAL_MEMORY_TEXT_REWRITES_FROM_FORGETTING = 0
- PERSONA_MUTATION_FROM_DERIVED_MEMORY = 0
- RELATIONSHIP_MUTATION_FROM_DERIVED_MEMORY = 0
- EMOTIONAL_STATE_MUTATION_FROM_DERIVED_MEMORY = 0
- SELF_NARRATIVE_AUTHORITY_MUTATION_FROM_DERIVED_MEMORY = 0
- BEHAVIOR_STATE_MUTATION_FROM_DERIVED_MEMORY = 0
- PREDICTION_ERROR_MUTATION_FROM_M = 0
- ACTIVE_MESSAGE_SCHEDULE_MUTATION_FROM_DERIVED_MEMORY = 0

## E. Desktop / Mobile capability truth

| Capability | Desktop primary chat | Mobile primary chat | Runtime consumption / fail-closed truth | Default and provider |
| --- | --- | --- | --- | --- |
| Canonical Recall + H | LIVE through server Recall | LIVE through Home Node retrieval | Desktop has no browser-side Recall fallback when server Recall is unavailable; it sends no Memory. Mobile also continues with empty Memory on read failure. ACL is fail-closed on both. | Existing Memory/group settings gate Recall. H has no independent toggle or model dependency. |
| Association | LIVE on the shared Home Node seam | LIVE after its one existing retrieval | Same selected IDs and same bounded runtime; errors fall back to direct Recall. | Enabled by default in code; can be disabled by IB_MEMORY_ASSOCIATION_ENABLED=0. Provider-dependent; no-provider/error is direct Recall. |
| K + L | LIVE when the per-character operator policy enables K | Same policy and owners | Desktop server response is then inserted by the browser; Mobile builds the context server-side. Both fail open to existing Recall/context. | K policy code default OFF; operator file may enable per character. K/L require the configured model provider. |
| N + O | LIVE for selected records and available upstream projections | Same | Private guidance; invalid/failing projections emit no derived guidance. No debug DTO/SSE disclosure. | No provider; derived when inputs are available. |
| P | LIVE as a source-separated view when both sides are evidenced | Same | Both sides/provenance stay separate; failed or absent authority cannot mint jointly acknowledged history. | Derivation is input-gated. Production explicit joint-ack authority is not assembled by default. |
| Q | LIVE for an explicit, grounded conditional premise | Same | Failure omits Q. It cannot alter actual history, create Memory, or write P.E. | Trigger and canonical anchors required; at most one provider call per eligible cycle. |
| M / response-guidance-v1 | LIVE renderer; consumption is not server-verifiable | LIVE renderer and runtime-verifiable prompt insertion | Desktop attribution remains unknown/partial without trusted receipt. Mobile marks consumed only after validation and insertion into the actual provider prompt. Invalid guidance is omitted. | Provider-dependent; missing evidence/schema/provider returns baseline. |
| Prediction Error feedback | LIVE in the single Home Node scope | Same server authority; Mobile consumption is verifiable | Desktop external influence stays unknown/partial. P3/P4 reject clean calibration when required decisive evidence is unknown. | Event/opportunity and provider-dependent; Calibration Application remains OFF/deferred. |

Desktop main 1:1 and group chat use ibRecallContextForTurn and insert server response guidance through the shared renderer (communication.js:1722-1773, 1821, 2024-2029, 2165-2205, 2975, 3412). A recall outage returns an empty context with browserFallback=false. Mobile derives from the already-selected set inside buildTurnRequest and catches cognition failure without aborting the turn (mobile-gateway.js:994-1034); the private cognition text and guidance are placed in server runtime context (mobile-gateway.js:1037-1100).

Auxiliary Desktop generation surfaces still call getMemoryContext directly (for example communication.js:58-60, communication/letters.js:259, and role-dm.js:565). They use the shared Recall core but do not claim the full K/L/N/O/P/Q/M primary-chat chain. This is consumer-scope truth, not a second ranking algorithm.

## F. Failure fallback chain

| Failure | Fallback |
| --- | --- |
| Canonical Memory read | Empty Memory block; Recall request returns normally. |
| H projection | Original Recall score, ranking, and detail projection; no Memory is deleted. |
| Association | Direct Recall only. |
| K | Recall + Association; no current interpretation. |
| L | K + Recall; prior session narrative if available, otherwise none. |
| N | Recall/K/L continue without awareness guidance. |
| O | Original Recall + N; no reconstructed distortion. |
| P | Original Recall + N/O; no shared fact. |
| Q or sealed P.E read | Existing cognition continues; no counterfactual view. P.E records remain unchanged. |
| M or response-guidance validation | Baseline posture / no posture envelope; response generation continues. |
| P1/P3/P4 feedback processing | Feedback is omitted or P4 skips/fails independently; Recall and chat are unaffected. |

Desktop’s recall wrapper is bounded and returns an empty context on unavailable/error; Mobile’s buildTurnRequest catches cognition exceptions and returns a normal turn request. Existing product tests exercise these fallbacks. Therefore NO_DERIVED_MEMORY_STAGE_CAN_KILL_CHAT = YES.

## G. Shadow / duplicate authority audit

SHADOW_AUTHORITY_COUNT = 0 means there are no competing active production authorities:

- Recall visibility, scoring, ranking, budget, and rendering all converge on memory-retrieval-core. Browser helpers delegate to that core; Home Node retrieval uses the same orchestrator/core. The primary Desktop chat path no longer falls back to browser-selected Memory.
- K has one runtime owner, runtime-interpretation. The bounded same-turn K path and the legacy direct-only nonblocking entry use that owner and validator; the latter is not a second response-context or behavior owner.
- L, N, O, P, Q, and M each have one current production owner. response-guidance-v1 is the shared envelope, not another posture producer.
- runtime-behavior-effect remains the sole behavior-attribution owner. P2, P1, P3, and P4 each retain one distinct authority. The P.E seam guard passes its single-authority and no-second-settlement checks.
- R4-B’s Meta-Memory shadow still has one internal diagnostic consumer: the orchestrator places it only in internal meta and memory.js projects it to an internal diagnostic field (memory-recall-orchestrator.js:926-960; test_metamemory_shadow.js:582-600). It does not affect selection or enter prompt/UI. N owns current private memory-state awareness.
- R4-E’s old counterfactual projection remains test-only. Q uses the bounded transport with a Q-specific schema and validator; Q is its single production transport consumer.
- The old R4-I roadmap row is a design snapshot. Current Self Narrative is L and current Shared Memory is P. It does not establish a second writer.

The R4-E description in tests/test-all.js was corrected to describe its remaining test-only protocol and Q’s single transport use. Historical phase contracts remain unchanged.

## H. Contract reconciliation

Current status is this closure record plus the latest append-only phase entries. The R4-H/N/O/P/Q entries are retained in RECONSTRUCTIVE_MEMORY_CONTRACT.md; the standalone PREDICTION_ERROR_V1_CLOSURE.md remains authoritative for P.E scope, durability, and deferred Calibration Application. The older design sections that say FUTURE, protocol-only, or implementation-none describe their original phase snapshot. This closure supersedes those statements only as a current-status index; it does not rewrite their historical truth.

Current mapping:

| Historical concept | Current meaning |
| --- | --- |
| R4-B | Historical deterministic Meta-Memory shadow; current private awareness is N. |
| R4-C | Existing direct-only post-recall nonblocking interpretation route; it shares the K runtime and is not a second current-meaning owner. |
| R4-E | Historical counterfactual schema/transport protocol; Q supplies the production projection and strict current validator. |
| R4-I | Historical design row for Self Narrative and Shared Memory; implemented owners are L and P. |
| R4-J | Historical unreliable-recollection roadmap row; current implementation is O. |
| R4-K/L/M/H/N/O/P/Q | Current implementation phase labels preserved in their append-only entries. |

## I. Test and red classification

Executed targeted suites on 2026-10-08:

| Suite | Result |
| --- | --- |
| Memory contract closure | 153 passed |
| Reconstructive Memory contract | 87 passed |
| Prediction Error seam guard | 56 passed |
| Prediction Error product E2E | 42 passed |
| Association product E2E | 9 passed |
| Semantic Forgetting product E2E | 12 passed |
| Reinterpretation product E2E | 10 passed |
| Self Narrative product E2E | 13 passed |
| Meta-Memory product E2E | 15 passed |
| Memory Unreliability product E2E | 16 passed |
| Shared Memory product E2E | 13 passed |
| Counterfactual product E2E | 16 passed |
| Behavior Modulation product E2E | 13 passed |
| Recall two-host parity | 152 passed |
| Mobile Memory continuity | 65 passed |
| Mobile response-guidance consumer | 9 passed |
| Desktop attribution admission | 6 passed |
| Home Node production Memory assembly | 30 passed |
| Recall orchestrator | 77 passed |
| Historical counterfactual shadow protocol / sole Q transport consumer | 81 passed |

Known reds:

1. P18 frozen-hash mismatch: test_memory_recall_contract.js reports 183 passed and 4 failed for assets/js/memory.js, assets/js/communication.js, assets/js/home-node-bootstrap.js, and services/home-node/memory-retrieval.js. The pinned memory-retrieval-core hash still passes. test_memory_recall_wiring_guard.js has 53 passed and 2 failures because it inherits those four P18 failures and expects the old assertion count. The current worktree is already dirty in those files; the red is a stale exact-byte baseline guard, not evidence of a Memory runtime regression in the targeted tests.
2. test_home_node_service.js reports 25 passed and 3 failed because its isolation checks match former bootstrap source spellings. The current bootstrap uses explicit degraded-surface branches, and the independent real production assembly suite passes 30 checks. This is stale static-assertion debt outside the Memory cognition chain.
3. No complete tests/test-all.js run is claimed for this closure. A prior broad run did not complete; the targeted suites above are the verification evidence.

Disposition recommendation for P18: keep the R2-A fixture immutable in this closure. A separate scoped maintenance decision should either establish a successor baseline after reviewing the changed files or replace byte-identity assertions with the current semantic authority guards. Do not silently regenerate the baseline to make the current dirty tree green.

Classification: TRUE_MEMORY_REGRESSIONS_FOUND = 0 in the executed targeted suites; stale static/hash guards and incomplete full-suite evidence are listed above; no unrelated red was fixed.

## J. Closure manifest

- MEMORY_RECALL = LIVE
- SEMANTIC_FORGETTING = LIVE
- ASSOCIATION = LIVE
- REINTERPRETATION = LIVE
- SELF_NARRATIVE = LIVE
- META_MEMORY = LIVE
- MEMORY_UNRELIABILITY = LIVE
- SHARED_MEMORY = LIVE
- COUNTERFACTUAL = LIVE
- MEMORY_BEHAVIOR_MODULATION = LIVE
- PREDICTION_ERROR = LIVE

- MEMORY_AUTHORITY_GRAPH = CONSISTENT
- SHADOW_AUTHORITY_COUNT = 0
- DERIVED_MODULE_CANONICAL_MEMORY_WRITES = 0
- DURABILITY_BOUNDARIES = DOCUMENTED
- DESKTOP_MOBILE_CAPABILITY_TRUTH = DOCUMENTED
- FAILURE_FALLBACK_CHAIN = VERIFIED
- CONTRACT_STATE = RECONCILED
- KNOWN_REDS = CLASSIFIED
- NO_DERIVED_MEMORY_STAGE_CAN_KILL_CHAT = YES
- NO_BLOCKING_CORRECTNESS_GAP = YES

- MEMORY_SYSTEM_V1_STATUS = ENGINEERING_CLOSED
- MEMORY_SYSTEM_V1_FREEZE = FROZEN

Default policy and limits:

- H, N, and O are deterministic and have no independent provider switch.
- Association is enabled by default in code, provider-dependent, and fail-open to direct Recall.
- K/L code-level policy default is OFF; the operator file can enable it per character.
- P emits only evidenced source-separated views; joint acknowledgement is unavailable unless explicit production authority is assembled.
- Q requires an explicit grounded premise and one bounded provider call.
- M requires usable K/L evidence and a provider; provider failure returns baseline.
- P.E uses one Home Node’s bounded session holders. Calibration Application and durable/multi-Home registry are deferred.
- Desktop guidance consumption remains unknown/partial; Mobile consumption is runtime-verifiable.

## K. Remaining post-v1 work

These are platform, durability, or quality work and do not currently violate Memory v1 correctness:

- Trusted Desktop provider execution convergence and a trusted consumption receipt.
- Production explicit joint-acknowledgement authority.
- Sentence-level forgetting.
- Real-provider semantic quality validation for K/L/M/Q.
- Durable storage/restart recovery or cross-Home support for session-only Self Narrative and P.E state.
- Controlled disposition of the stale P18 frozen-hash guard and the stale Home Node bootstrap regex checks.
- A completed full-suite run after unrelated dirty-worktree debt is reviewed.
- Extending the full reconstruction chain to auxiliary Desktop generation surfaces that currently consume base Recall only.

## L. Final status

The authority graph is consistent; the active production chain has one owner per authority; derived modules do not write canonical Memory or the protected state authorities; and failure paths preserve Recall/Chat. Desktop/Mobile differences, session-only durability, current defaults, old phase wording, and known test reds are explicit above.

- MEMORY_SYSTEM_V1_STATUS = ENGINEERING_CLOSED
- MEMORY_SYSTEM_V1_FREEZE = FROZEN

No feature work, runtime migration, unrelated red repair, staging, commit, or push was performed for this closure.
