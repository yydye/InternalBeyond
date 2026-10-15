# Prediction Error v1 Engineering Closure

**Audit date:** 2026-10-07\
**Scope:** `SINGLE_HOME_NODE`\
**Status:** `ENGINEERING_CLOSED` after the Tier A/B gates and PE-relevant Tier C regressions passed.\
**Source order:** production code, enforcement tests, current contracts, this closure record, then historical phase notes.

This record closes the single-Home-Node v1 engineering work. It adds no product capability, authority, or distributed topology. The original design-only headers in the two long-form contracts are historical proposal headers; the appended I.28 and q-48 entries record current implementation status without rewriting those sections.

## A. v1 scope

```text
PREDICTION_ERROR_V1_SCOPE = SINGLE_HOME_NODE
SINGLE_HOME_PREDICTION_ERROR_PRODUCTION_CHAIN = CLOSED
PREDICTION_ERROR_V1_SINGLE_HOME = PRODUCTION_READY
MULTI_HOME_PREDICTION_ERROR = DEFERRED_BY_PLATFORM_DEPENDENCY
CALIBRATION_APPLICATION = INTENTIONALLY_DEFERRED
CALIBRATION_CONFIDENCE = null
RESTART_RECOVERY = NONE
DURABLE_PREDICTION_REGISTRY = NO
```

Production Prediction creation is restricted to validated structured preference and the `runtime.turn_terminal` family bound to the active D3 execution turn. Arbitrary event families, latent-state projection, and relational production projection remain off. The production event source remains terminal RealityEvent; free text cannot choose a terminal outcome.

## B. Canonical capability matrix

| Capability | Implementation | Production status | Default / gate | Scope and durability | Deferred or blocked |
| --- | --- | --- | --- | --- | --- |
| Structured preference Prediction creation | IMPLEMENTED | PRODUCTION_LIVE | Requires a validated structured preference | One Home Node; Registry SESSION_ONLY | None |
| Terminal Event Prediction creation | IMPLEMENTED | PRODUCTION_LIVE for `runtime.turn_terminal` only | Exact active D3 turn and matching request correlation | One Home Node; Registry SESSION_ONLY | Arbitrary event families OFF |
| Structured Explicit User Report | IMPLEMENTED | PRODUCTION_LIVE | Existing authenticated report action and canonical character binding | Report/RealityEvent authority holders SESSION_ONLY | Raw chat is not an Explicit Report |
| Free-text candidate extraction | IMPLEMENTED | PRODUCTION_LIVE as a candidate only | Exact deterministic first-person grammar | Browser session, bounded candidate holder | Candidate has no report or settlement authority |
| Free-text report confirmation | IMPLEMENTED | PRODUCTION_LIVE | USER_CONFIRMATION_REQUIRED | Reuses the existing report route; report authority SESSION_ONLY | No confirmation means no report |
| Terminal RealityEvent source | IMPLEMENTED | PRODUCTION_LIVE | Runtime execution finality and fixed source grammar | RealityEvent holder SESSION_ONLY | No model-minted event authority |
| Raw-chat linguistic evidence producer | IMPLEMENTED | PRODUCTION_LIVE after canonical chat commit | Fixed `LINGUISTIC_EVIDENCE` producer and P1 ceiling | Source chat row durable; evidence projection SESSION_ONLY | Does not mint Explicit Reports or RealityEvents |
| Deterministic mechanical relation | IMPLEMENTED | PRODUCTION_LIVE | Canonical token/proposition comparison | Same Home Node runtime | No free-text inference |
| Evidence Matcher | IMPLEMENTED | Production capability LIVE | DEFAULT_OFF; process opt-in is `IB_EVIDENCE_MATCHER_ENABLED=1`; isolated instances require explicit `true` | Owner-local; bounded SESSION_ONLY memo | Matcher is advisory and cannot settle |
| Subjective Explicit Report Opportunity | IMPLEMENTED | PRODUCTION_LIVE | Canonical report witness plus same-scope sealed facts | Session-local authority | Absence of a report is not contradiction |
| Terminal Event Opportunity | IMPLEMENTED | PRODUCTION_LIVE | Same-turn sealed terminal RealityEvent | Session-local authority | No caller-injected Opportunity |
| BehaviorEffect attribution | IMPLEMENTED | PRODUCTION_LIVE | Canonical runtime attribution authority | Bounded SESSION_ONLY | Unknown is not known-none |
| P3 Settlement | IMPLEMENTED | PRODUCTION_LIVE | P1, relation, Opportunity, and policy gates | Bounded SESSION_ONLY | P3 alone owns the seven settlement states |
| P4 Calibration Ledger | IMPLEMENTED | PRODUCTION_LIVE sample collection | Only sealed P3 records with `calibrationCounted=true` | SESSION_ONLY | No application to live cognition |
| P4 production driver | IMPLEMENTED | PRODUCTION_LIVE automatic P3-to-P4 dispatch | Same runtime assembly; P4 performs dedupe | SESSION_ONLY | Driver does not rejudge P3 |
| Calibration Confidence | NOT_IMPLEMENTED | NOT_LIVE | `null` by contract | None | No confidence formula |
| Calibration Application | INTENTIONALLY_DEFERRED | OFF | No score, weighting, prompt adjustment, or writeback | None | Separate future capability phase |
| Multi-Home Prediction owner binding | NOT_IMPLEMENTED | NOT_LIVE | No canonical node/session owner binding | No durable owner reconstruction | BLOCKED_BY_MISSING_PREDICTION_OWNER_BINDING |
| Multi-Home feedback routing | NOT_IMPLEMENTED | BLOCKED | No authenticated node-to-node channel | No route envelope or queue | BLOCKED_BY_NO_AUTHENTICATED_NODE_ROUTING_CHANNEL |
| Restart recovery | NOT_IMPLEMENTED | NOT_LIVE | `RESTART_RECOVERY=NONE` | Session-only authorities expire | No recovery by database guess |
| Durable Prediction Registry | NOT_IMPLEMENTED | NOT_LIVE | `DURABLE_PREDICTION_STORE=NO_V1` | None | Not planned in v1 |
| Arbitrary Event projection | INTENTIONALLY_OFF | NOT_LIVE | Closed production family allowlist | None | Future phase only |
| Latent-state production projection | INTENTIONALLY_OFF | NOT_LIVE | No production P2 projection | None | Future phase only |
| Relational production projection | INTENTIONALLY_OFF | NOT_LIVE | No production P2 projection | None | Future phase only |

The source of the structured projection allowlist is `services/home-node/runtime-structured-expectation.js:46,167-175`. The unchanged P1 authority matrix is in `assets/js/memory-recall/outcome-observation-core.js:136-181`; D5 adds terminal token vocabulary in the same core, not a new source/domain/explicitness authority matrix.

## C. Authority invariant audit

All listed invariants PASS in the current production code and the Tier A/B gates.

| Invariant | Result and implementation evidence |
| --- | --- |
| `LLM_UNDERSTANDING != RUNTIME_AUTHORITY` | PASS — candidate normalization and runtime-derived fields: `services/home-node/runtime-structured-expectation.js:156-220`; the sole P2 projection remains in `services/home-node/runtime-expectation.js:403-410`. |
| `RAW_CHAT_TEXT != EXPLICIT_REPORT` | PASS — candidate extraction never mints a report: `assets/js/free-text-report-candidate.js:38-68,214-253`; the canonical report producer declares `rawChatTextIsExplicitReport: NO` at `services/home-node/runtime-explicit-preference-report.js:222-225`. |
| `LINGUISTIC_EVIDENCE != EXPLICIT_USER_REPORT` | PASS — fixed source and domain: `services/home-node/runtime-linguistic-evidence.js:20-25,258-263`; P1 keeps its source classes separate at `assets/js/memory-recall/outcome-observation-core.js:69-78,136-163`. |
| `RELATION != OPPORTUNITY` | PASS — Matcher emits relation only; event and subjective Opportunity have separate constructors: `services/home-node/runtime-evidence-matcher.js:20-23`; `services/home-node/runtime-event-opportunity-authority.js:29`; `services/home-node/runtime-subjective-opportunity-authority.js:33`. |
| `OPPORTUNITY != SETTLEMENT` | PASS — P3 calls the injected composite Opportunity authority, validates its sealed result, then computes the settlement: `services/home-node/runtime-prediction-settlement.js:204-209,244-260`. |
| `MATCHER != SETTLEMENT_AUTHORITY` | PASS — Matcher-aware entry is still a P3 method and P3 seals the result: `services/home-node/runtime-prediction-settlement.js:55-112,258-276,622`. |
| Matcher cannot upgrade source/domain/explicitness/Opportunity | PASS — Matcher production-admission suite passed; the five-key input and system-only provider configuration are enforced in `services/home-node/runtime-evidence-matcher.js:263-285,480-487`. |
| `REALITY_EVENT_IS_PREDICTION_INDEPENDENT` | PASS — RealityEvent rejects a `predictionId`: `services/home-node/runtime-reality-event.js:150-163`; it is a fact object, while P1 creates a prediction-scoped projection in `services/home-node/runtime-outcome-observation.js:192-215`. |
| `P3_IS_SETTLEMENT_AUTHORITY` | PASS — only the P3 runtime seals settlement records: `services/home-node/runtime-prediction-settlement.js:55-112,467-509`. |
| `P4_DOES_NOT_REJUDGE_P3` | PASS — P4 verifies the P3 seal and `calibrationCounted`; driver only forwards: `services/home-node/runtime-prediction-calibration.js:207-218`; `services/home-node/runtime-prediction-calibration-driver.js:52-92`. |
| `SELF_INFLUENCED_SAMPLE_IS_NOT_CALIBRATION_COUNTED` | PASS — `calibrationCounted` requires matched/missed and no self-influence: `assets/js/memory-recall/prediction-settlement-core.js:723-729`. |
| `P1_MATRIX_CHANGED = NO` | PASS — the G2/D5 change adds only terminal-token functions and token entries; the authority matrix itself is unchanged. P1 authority suite passed. |

```text
AUTHORITY_INVARIANT_AUDIT = PASS
SHADOW_AUTHORITY_COUNT = 0
NO_NEW_SEMANTIC_FEATURE = YES
```

## D. Durability truth table

| Object | Authority owner | Durability |
| --- | --- | --- |
| Prediction Registry | One Home Node runtime Registry instance | SESSION_ONLY; process-memory `Map`; restart recovery NONE (`runtime-prediction-registry.js:76-80,299-318`) |
| RealityEvent holder | Home Node RealityEvent authority | SESSION_ONLY; bounded in-memory holder, zero durable writes (`runtime-reality-event.js:35,177,334-361`) |
| Opportunity resolution | Separate event/subjective authorities, composed for P3 | Process-local sealed resolution; no durable store; source report/event holders remain session-only |
| Settlement holder | P3 runtime | SESSION_ONLY; bounded in-memory `Map` (`runtime-prediction-settlement.js:175-181,561-575`) |
| P4 Ledger | P4 runtime paired with that P3 assembly | SESSION_ONLY; in-memory partitions and dedupe (`runtime-prediction-calibration.js:124-137,415-428`) |
| Explicit Report fact | Existing explicit preference report producer | SESSION_ONLY; bounded `Map`, `durableWrites=0` (`runtime-explicit-preference-report.js:46,105,217-241`) |
| Chat message | Home Node canonical chat store | Durable SQLite row in the Home Node database (`services/home-node/chat-store.js:182-184,246-248`) |
| Linguistic evidence fact | Home Node linguistic evidence producer | SESSION_ONLY projection; source is the already committed durable chat row; producer reports `durableWrites=0` (`runtime-linguistic-evidence.js:40,54,224-263`) |
| Free-text report candidate | Browser candidate session | Bounded SESSION_ONLY Map with expiry; no persistence (`assets/js/free-text-report-candidate.js:25,75-80,144-186`) |

## E. Production path truth table

| Path | Creation | Positive settlement | Negative settlement | P4 ingest |
| --- | --- | --- | --- | --- |
| Structured preference | PRODUCTION_LIVE through the validated structured expectation path | `matched` when P1/relation/policy gates permit | `missed` only with decisive eligible evidence and required Opportunity | Automatic for P3-counted settlement |
| Terminal Event | PRODUCTION_LIVE for active-turn-bound `runtime.turn_terminal` only | `matched` on the same-turn terminal outcome | `missed` on a directional terminal mismatch under the event Opportunity | Automatic for P3-counted settlement |
| Free-text Explicit Report | Candidate is LIVE; canonical report only after confirmation | `matched` through existing report authority and P3 where policy permits | `missed` only where P1 and Opportunity allow it | Automatic for P3-counted settlement |
| Raw chat | Producer is LIVE after a new canonical user row commits | P1-controlled `LINGUISTIC_EVIDENCE`; supporting evidence cannot independently settle decisively | Matcher conflict cannot become missed without the existing directional authority and Opportunity | Automatic only if P3 marks eligible; self-influenced samples remain excluded |

Matcher remains `DEFAULT_OFF`. Its opt-in classifies statements but cannot promote `LINGUISTIC_EVIDENCE` to `EXPLICIT_USER_REPORT`. `CALIBRATION_APPLIED_TO_LIVE=NO` for every path.

## F. Contract reconciliation

- `PREDICTION_ERROR_AUTHORITY_CONTRACT.md` keeps its original design-proposal and historical phase text unchanged. I.28 appended below clarifies that the early `IMPLEMENTATION=NONE` header described the original proposal snapshot and is superseded for current status by I.24-I.28 and this closure record.
- `RECONSTRUCTIVE_MEMORY_CONTRACT.md` keeps q-44 through q-47 as phase-time history. q-48 below records the current v1 scope and links to this engineering closure. q-47 already records the live linguistic producer, unchanged P1 matrix, Matcher default-off, and Calibration Application off.
- No code/contract discrepancy remains for G2, K, L, L-R1, P1 matrix status, Matcher default, single-Home-Node scope, or Calibration Application.
- Historical statements such as q-46 “no raw-chat statement producer” remain accurate for q-46; q-47 later adds that producer. They are not current readiness assertions.

## G. Shadow / duplicate authority audit

The audit found no shadow authority:

- One `createRuntimePredictionRegistry` implementation; production and isolated `buildHomeNode` assemblies instantiate it.
- One explicit report producer. The HTTP seam validates/derives ingress; the free-text parser only proposes an untrusted candidate and confirmation reuses that report producer.
- One canonical preference grammar in `preference-proposition-core.js`; structured preference and Explicit Report reuse it.
- One terminal outcome token grammar in P1 `outcome-observation-core.js`; structured projection, observation projection, and Event Opportunity consume that grammar instead of defining competing token maps.
- Matcher configuration has one production opt-in point in `home-node-service.js`; Matcher has no independent environment resolver.
- Subjective and event Opportunity authorities own different domains and are composed by `runtime-opportunity-authority.js`; they are not duplicate authorities.
- P3 exposes synchronous and Matcher-aware entry methods on the same settlement runtime; both settle and seal through P3. P4 has one `ingestSettlement` method and one production driver.
- One linguistic evidence producer is called by the post-commit canonical chat-store callback.

```text
SHADOW_AUTHORITY_COUNT = 0
```

## H. File ownership and closure manifest

The worktree contains both Prediction Error changes and unrelated UI/release work. The tables below name only PE-owned files or mixed PE integration files; the excluded lists are preserved as-is.

### H.A Prediction Error closure-owned files

| A/M | File | Phase and purpose | Kind | Needed in PE commit |
| --- | --- | --- | --- | --- |
| M | `services/home-node-service.js` | G2/K/L/L-R1/J composition; wires local authorities | Production | YES |
| M | `services/home-node/chat-store.js` | L-R1 post-commit canonical user-message fact | Production | YES |
| M | `services/home-node/execution.js` | G2 active D3 terminal binding/sink boundary | Production | YES |
| M | `services/home-node/runtime-behavior-effect.js` | P5-B2/J attribution authority and seal | Production | YES |
| M | `services/home-node/runtime-evidence-matcher.js` | L Matcher production capability and bounded inputs | Production | YES |
| M | `services/home-node/runtime-expectation.js` | G2 structured projection wiring | Production | YES |
| M | `services/home-node/runtime-explicit-preference-report.js` | K reuses the canonical report producer | Production | YES |
| M | `services/home-node/runtime-outcome-observation.js` | P1/G2 terminal and L-R1 observation projection | Production | YES |
| M | `services/home-node/runtime-prediction-calibration.js` | P4 ledger checks and session-only status | Production | YES |
| M | `services/home-node/runtime-prediction-settlement.js` | P3 Matcher-aware path and sealed settlement | Production | YES |
| M | `services/home-node/runtime-reality-event.js` | D4/G2/K canonical fact source allowlist | Production | YES |
| M | `services/home-node/runtime-reality-feedback.js` | Existing local P1/P3 feedback path and Matcher opt-in | Production | YES |
| M | `services/home-node/runtime-recall.js` | G2 carries the request correlation selector to projection | Production | YES |
| M | `services/home-node/runtime-structured-expectation.js` | G2 sole structured production projection allowlist | Production | YES |
| A | `services/home-node/runtime-event-opportunity-authority.js` | D5-R1 same-turn terminal Opportunity | Production | YES |
| A | `services/home-node/runtime-opportunity-authority.js` | E/I composite of distinct Opportunity domains | Production | YES |
| A | `services/home-node/runtime-subjective-opportunity-authority.js` | E explicit-report Opportunity | Production | YES |
| A | `services/home-node/runtime-prediction-calibration-driver.js` | J automatic sealed P3-to-P4 handoff | Production | YES |
| A | `services/home-node/runtime-linguistic-evidence.js` | L-R1 canonical chat fact to P1 projection | Production | YES |
| M | `assets/js/memory-recall/expectation-shadow-core.js` | G2 structured terminal candidate schema | Production dependency | YES |
| M | `assets/js/memory-recall/outcome-observation-core.js` | P1 authority matrix plus D5 terminal token vocabulary | Production authority | YES |
| M | `assets/js/memory-recall/prediction-calibration-core.js` | P4 truth/partition logic | Production authority | YES |
| M | `assets/js/memory-recall/prediction-settlement-core.js` | P3 seven-state and calibration eligibility logic | Production authority | YES |
| M | `assets/js/memory-recall/behavior-effect-attribution-core.js` | P5-B2 attribution contract; byte-only BOM fix | Production authority | YES |
| M | `assets/js/memory-recall/evidence-match-core.js` | Matcher relation core; byte-only BOM fix | Production authority | YES |
| M | `assets/js/memory-recall/expectation-shadow-runner.js` | Existing structured expectation producer dependency; byte-only BOM fix | Production dependency | YES |
| M | `assets/js/memory-recall/prediction-observation-core.js` | P1 observation authority; byte-only BOM fix | Production authority | YES |
| M | `assets/js/memory-recall/prediction-record-core.js` | P2 Prediction identity/projection; byte-only BOM fix | Production authority | YES |
| M | `assets/js/free-text-report-candidate.js` | K candidate-only parser/session; no report authority | Production UI asset | YES |
| M | `assets/js/home-node-bootstrap.js` | K browser-facing wrapper for existing report route | Production UI asset | YES |
| M | `assets/js/home-node-client.js` | K narrow transport for existing report route | Production UI asset | YES |
| M | `docs/contracts/memory/PREDICTION_ERROR_AUTHORITY_CONTRACT.md` | Append-only I.24-I.28 authority status | Contract | YES |
| M | `docs/contracts/memory/RECONSTRUCTIVE_MEMORY_CONTRACT.md` | Append-only q-44-q-48 phase/status record | Contract | YES |
| A | `docs/contracts/memory/PREDICTION_ERROR_V1_CLOSURE.md` | Canonical current v1 engineering closure | Closure doc | YES |

#### H.A.1 Tracked PE regression tests

| A/M | File | Phase and test role | Needed in PE commit |
| --- | --- | --- | --- |
| M | `tests/test_behavior_effect_attribution.js` | P5-B2/J attribution invariants | YES |
| M | `tests/test_evidence_matcher.js` | Matcher semantic and default-off core | YES |
| M | `tests/test_explicit_user_report_authority.js` | Explicit Report/K and Matcher configuration | YES |
| M | `tests/test_outcome_observation_authority.js` | P1 source matrix and observation authority | YES |
| M | `tests/test_outcome_observation_production.js` | Production P1 producer boundaries | YES |
| M | `tests/test_prediction_calibration_ledger.js` | P4 ledger and calibration truth | YES |
| M | `tests/test_prediction_error_product_e2e.js` | G2/K/I/J production chain E2E | YES |
| M | `tests/test_prediction_error_seam_guard.js` | N stale consumer allowlist corrected to the five named P1-core consumers | YES |
| M | `tests/test_prediction_settlement_core.js` | P3 state and authority invariants | YES |
| M | `tests/test_reality_event_backbone.js` | RealityEvent source and prediction-independent identity | YES |
| M | `tests/test_reality_feedback_driver.js` | Local feedback and existing P3 Matcher-aware path | YES |
| M | `tests/test_runtime_fact_authority.js` | D3 terminal identity and fact boundary | YES |
| M | `tests/test_structured_expectation_projection.js` | G1/G2 structured projection | YES |
| M | `tests/test_subjective_prediction_feedback.js` | K report/Opportunity path; N default-off assertion aligned to explicit gates | YES |
| M | `tests/test_turn_execution_authority.js` | G2 active D3 turn binding | YES |
| M | `tests/test_turn_observer_admission.js` | G2 terminal P1 observer; N default-off assertion aligned to explicit gates | YES |
| M | `tests/test_turn_terminal_directional_admission.js` | D5 directional terminal admission | YES |
| M | `tests/test_turn_terminal_reality_source.js` | D5 canonical terminal source | YES |

The Tier A/B/C test result tables in J/K name every required suite, including the eleven untracked PE suites below. Those tests are needed to keep their corresponding production and authority changes coherent.

### H.B Dependency and mixed lockstep files

| A/M | File | PE portion | Other dirty portion | Commit handling |
| --- | --- | --- | --- | --- |
| M | `assets/js/communication.js` | K candidate card creation, confirm/dismiss, existing report action | Chat/side-effect/UI edits | Select PE hunks only |
| M | `InternalBeyond.html` | K script include for candidate parser | Broader visual script/style changes | Select PE loader hunk only |
| A | `assets/css/chat-family.css` | K candidate-card style block | Broad chat visual system | Mixed; include only with the related UI dependency or extract the PE block later |
| A | `assets/css/ui-primitives.css` | Token values consumed by the K card styles | Broad UI primitive system | Mixed visual dependency; do not treat the whole UI system as PE authority |
| M | `tests/test-all.js` | Explicit registration of PE Tier A/B suites | Unrelated UI test registrations | Select PE registration hunks |
| M | `tests/test_chat_smoke.js` | K candidate/confirmation browser assertions | Other chat UI smoke changes | Select PE assertions only |
| M | `tests/test_m1a_chat_authority_smoke.js` | Home Node browser regression test now supplies its explicit test token | Test setup only | Keep as integration-test lockstep |

### H.C Unrelated tracked dirty files excluded from the PE candidate

`README.md`, `VERSION`, `assets/css/core.css`, `assets/css/core/widgets.css`, `assets/css/home-workspace.css`, `assets/css/navigation-shell.css`, `assets/js/bridge.js`, `assets/js/core.js`, `assets/js/error-catalog.js`, `assets/js/home-workspace.js`, `assets/js/memory.js`, `assets/js/navigation-shell.js`, `assets/js/social.js`, `assets/js/workspace.js`, `docs/architecture/UI-SURFACE-AUTHORITY.md`, `src-tauri/Cargo.lock`, `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `tests/test_delivery_runtime.js`, `tests/test_frontend_structure.js`, `tests/test_group_dynamic_runtime.js`, `tests/test_home_workspace.js`, `tests/test_navigation_shell.js`.

### H.D Untracked PE files

These 18 paths are required or PE-owned additions and were untracked at audit time:

1. `assets/js/free-text-report-candidate.js`
2. `services/home-node/runtime-event-opportunity-authority.js`
3. `services/home-node/runtime-linguistic-evidence.js`
4. `services/home-node/runtime-opportunity-authority.js`
5. `services/home-node/runtime-prediction-calibration-driver.js`
6. `services/home-node/runtime-subjective-opportunity-authority.js`
7. `tests/test_calibration_capability_truth.js`
8. `tests/test_calibration_production_driver.js`
9. `tests/test_event_opportunity_authority.js`
10. `tests/test_evidence_matcher_production_admission.js`
11. `tests/test_free_text_report_candidate.js`
12. `tests/test_free_text_report_confirmation.js`
13. `tests/test_linguistic_evidence_producer.js`
14. `tests/test_linguistic_evidence_product_e2e.js`
15. `tests/test_structured_event_prediction_projection.js`
16. `tests/test_subjective_opportunity_authority.js`
17. `tests/test_turn_terminal_directional_semantics.js`
18. `docs/contracts/memory/PREDICTION_ERROR_V1_CLOSURE.md`

`assets/css/chat-family.css` is an additional untracked mixed UI dependency recorded in H.B; its PE-specific selector block is present, but the whole stylesheet is not classified as a Prediction Error authority file.

### H.E Untracked unrelated files excluded from the PE candidate

`Video/08e2b1dc2b734d4fafae30c3fb9f2f01 (1).mp4`, `android/app/src/main/java/com/internalbeyond/mobile/ui/theme/IbSemanticTokens.kt`, `assets/css/ui-overlay-primitives.css`, `assets/js/ui-overlay-lifecycle.js`, `deleted-backup-audit.json`, `docs/architecture/IB_CHAT_FAMILY_MIGRATION_V1.md`, `docs/architecture/IB_UI_PRIMITIVE_CONTRACT_V1.md`, `docs/architecture/IB_VISUAL_LANGUAGE_V1.md`, `docs/architecture/IB_VISUAL_TOKEN_CONTRACT_V1.md`, `docs/release-notes/1.0.7.md`, `hibit-identity-transition-report.json`, `role-metadata-continuity-report.json`, `tests/fixtures/feedback-overlays/fixture.css`, `tests/fixtures/feedback-overlays/fixture.js`, `tests/fixtures/feedback-overlays/index.html`, `tests/fixtures/ui-primitives/fixture.css`, `tests/fixtures/ui-primitives/index.html`, `tests/test_chat_state_presentation_authority.js`, `tests/test_ui_overlays.js`, `tests/test_ui_primitives.js`.

## I. Tracking audit

```text
PE_REQUIRED_UNTRACKED_FILES = FULLY_ENUMERATED
M_AUDIT_DOCUMENT_IN_WORKTREE = NONE
P5-B3-M_IMPLEMENTATION_FILES_ADDED = 0
INDEX_EMPTY = YES
```

The test runner already registers the required PE core suites in `tests/test-all.js`; the exact registered suites and this audit's bounded results are in J/K. No untracked test or source file was staged.

## J. Core test matrix

Each suite ran as a separate Node child with a 90-second hard timeout. Two stale static assertions were corrected without changing production semantics and each failed suite was rerun successfully. No suite timed out.

**Tier A — PASS, 26/26 suites:**

`test_prediction_error_seam_guard.js`, `test_prediction_registry.js`, `test_outcome_observation_authority.js`, `test_outcome_observation_production.js`, `test_reality_event_backbone.js`, `test_reality_feedback_driver.js`, `test_prediction_settlement_core.js`, `test_behavior_effect_attribution.js`, `test_subjective_opportunity_authority.js`, `test_event_opportunity_authority.js`, `test_turn_terminal_directional_semantics.js`, `test_turn_terminal_directional_admission.js`, `test_turn_terminal_reality_source.js`, `test_structured_expectation_projection.js`, `test_structured_event_prediction_projection.js`, `test_explicit_user_report_authority.js`, `test_free_text_report_candidate.js`, `test_free_text_report_confirmation.js`, `test_subjective_prediction_feedback.js`, `test_evidence_matcher.js`, `test_evidence_matcher_production_admission.js`, `test_linguistic_evidence_producer.js`, `test_prediction_calibration_ledger.js`, `test_calibration_capability_truth.js`, `test_calibration_production_driver.js`, `test_runtime_fact_authority.js`.

The seam guard's old one-consumer list was updated to the five named P1-core consumers; the P1 core still has one observation builder and no second P3 authority. The old Matcher assertion `enabled: false` was updated to verify the actual frozen default and both explicit opt-in gates.

## K. Integration regressions

**Tier B — PASS, 2/2 suites, 120-second hard timeout:** `test_prediction_error_product_e2e.js` and `test_linguistic_evidence_product_e2e.js`. Both were rerun after the byte-only BOM changes and passed.

**Tier C — PE-relevant regression gate PASS.** The 16 invoked suites were `test_chat_authority.js`, `test_chat_smoke.js`, `test_home_node_http.js`, `test_home_node_execution.js`, `test_home_node_service.js`, `test_mobile_device_registry.js`, `test_mobile_gateway_http.js`, `test_home_node_middle_brain_assembly.js`, `test_home_node_production_memory_assembly.js`, `test_memory_authority.js`, `test_memory_smoke.js`, `test_turn_execution_authority.js`, `test_turn_observer_admission.js`, `test_delivery_runtime.js`, `test_m1a_chat_authority_smoke.js --browser`, and `test_reconstructive_memory_contract.js`.

Fifteen passed after the stale `test_turn_observer_admission.js` Matcher assertion was aligned; the contract suite passed 87 assertions. `test_home_node_service.js` still has three unrelated static bootstrap-regex failures listed in L; its remaining 25 checks passed, dynamic Home Node HTTP/execution/assembly tests passed, and the source still contains all three fail-closed early returns. This stale, non-PE assertion set is not counted as a PE regression.

## L. Known red classification

| Suite | Current result | Classification | Decision |
| --- | --- | --- | --- |
| `test_middle_brain_side_effect_gate.js` | 6 static call-site/route-count assertions fail | PRE_EXISTING, STALE_TEST, UNRELATED | No PE code change; do not alter Middle Brain behavior in this closure |
| `test_chat_core_contract.js` | One database-version assertion fails while reporting `DB_VER=24` | PRE_EXISTING, STALE_TEST, UNRELATED | No Chat DB change in PE scope |
| `test_home_node_service.js` | Three early-return regex assertions fail; actual bootstrap still returns after missing dependencies | PRE_EXISTING, STALE_TEST, UNRELATED | Leave unchanged; dynamic Home Node regressions passed |
| `test_frontend_structure.js` | After PE BOM fixes, six unrelated missing-BOM assertions and one stale image-router wording assertion remain | PRE_EXISTING, STALE_TEST, UNRELATED | PE BOM debt fixed; no broad BOM insertion or image-router wording change |
| `test_image_router.js` | PASS | No red | No action |

No known red was both PE-related and a real production regression.

## M. Harness and process state

```text
TEST_HARNESS_HANG = NOT_REPRODUCED
SINGLE_SUITE_HARD_TIMEOUT = 90s (120s for product/browser E2E)
PID_SPECIFIC_CLEANUP_ONLY = YES
NODE_OR_CHROME_MASS_KILL = NO
```

All suites exited within their bounds. No test-owned Node process, test Chrome profile, or temporary HTTP listener remained at the final audit. No PID cleanup was needed. The installed runtime processes were not restarted.

The remaining Node processes all belong to the installed application under `[local path redacted]`, not this workspace. Their listeners are the installed services' existing loopback ports:

| PID | Parent PID | CommandLine | Listener |
| ---: | ---: | --- | ---: |
| 1492 | 26356 | `...\runtime\local-services-runner.js` | 127.0.0.1:23116 |
| 3988 | 1492 | `...\services\active-message-service.js` | 127.0.0.1:23114 |
| 10904 | 1492 | `...\services\home-node-service.js` | 127.0.0.1:23118 |
| 23292 | 1492 | `...\services\ib-bridge-service.js` | 127.0.0.1:23115 |
| 27596 | 26356 | `...\services\internal-beyond-server.js` | 127.0.0.1:23120 |

```text
TEST_NODE_PROCESSES = 0
TEST_CHROME_PROFILES = 0
WORKSPACE_OR_TEST_OWNED_LISTENERS = 0
INSTALLED_RUNTIME_NOT_RELOADED_WITH_WORKSPACE_CHANGES = YES
```

## N. Encoding, line endings, and diff check

PE-owned front-end files missing the repository UTF-8 BOM were fixed by prepending exactly the three BOM bytes with a byte-preserving script; LF/CRLF bytes were not converted. The 11 repaired files are `assets/js/home-node-bootstrap.js`, `assets/js/home-node-client.js`, `assets/js/memory-recall/behavior-effect-attribution-core.js`, `assets/js/memory-recall/evidence-match-core.js`, `assets/js/memory-recall/expectation-shadow-core.js`, `assets/js/memory-recall/expectation-shadow-runner.js`, `assets/js/memory-recall/outcome-observation-core.js`, `assets/js/memory-recall/prediction-calibration-core.js`, `assets/js/memory-recall/prediction-observation-core.js`, `assets/js/memory-recall/prediction-record-core.js`, and `assets/js/memory-recall/prediction-settlement-core.js`.

`PE_OWNED_ENCODING_DEBT = BOM_FIXED; NO_TRAILING_WHITESPACE_ON_CHANGED_LINES; LINE_ENDINGS_UNNORMALIZED`. Remaining missing-BOM files are unrelated: `assets/js/memory-authority.js`, `assets/js/memory-recall/counterfactual-shadow-core.js`, `assets/js/memory-recall/counterfactual-shadow-runner.js`, `assets/js/memory-recall/memory-interpretation-core.js`, `assets/js/memory-recall/memory-interpretation-runner.js`, and `assets/js/memory-recall/metamemory-shadow.js`. Their BOMs were not changed.

Final `git diff --check` exits 0. Git reports only its configured CRLF/LF conversion warnings; those are recorded as line-ending metadata warnings, not semantic failures. No whole-repository normalization was run.

## O. Security closure

- Prediction Error and Home Node diagnostics do not log `apiKey`; the existing Home Node redactor masks API keys/tokens. HTTP and device-registry secret-boundary suites passed.
- Matcher prompt/input uses the five-key whitelist and does not take provider, model, endpoint, credential reference, or `apiKey` from evidence. The provider call receives its owner-local resolved Vault credential only in its provider `spec`; that secret is not included in the Matcher prompt/input or logs. `test_evidence_matcher_production_admission.js` passed these boundaries.
- Linguistic evidence carries a bounded excerpt from the committed user row and fixed source/domain metadata, not credential fields, attachments, prompt, history, or Memory. The product E2E checked secret/provider/prompt/history sentinels and passed.
- Explicit Report envelope accepts only `requestId`, `characterId`, `targetKey`, `stance`, and `threadId`; forbidden provider overrides are rejected (`explicit-preference-report-seam.js:73-96,256-275`).
- Middle Brain secret projection is unchanged. M added no route or routing envelope, so `MULTI_HOME_ROUTING_SECRET_PROJECTION=0` for this worktree change.

## P. Multi-Home deferred dependency

The M audit remains authoritative: no canonical Prediction owner binding and no authenticated Home Node-to-Home Node channel exist. M is not implemented and is not part of v1 readiness.

```text
MULTI_HOME_PREDICTION_ERROR_SUPPORT = DEFERRED_BY_PLATFORM_DEPENDENCY
MULTI_HOME_NODE_OWNER_BINDING = NOT_LIVE
MULTI_HOME_NODE_FEEDBACK_ROUTING = BLOCKED
P5_B3_M_STATUS = BLOCKED
```

Reopen as `P5-B3-M-R1` only after the Home Node platform supplies all three: `CANONICAL_NODE_IDENTITY=LIVE`, `NODE_SESSION_IDENTITY=LIVE`, and `AUTHENTICATED_ROUTING=LIVE`. Required platform dependencies are node identity, runtime session/epoch identity, authenticated routing, and a canonical Prediction owner binding. No routing secret, queue, Registry, Vault, or seal serialization was added here.

## Q. Calibration deferred state

```text
P4_SAMPLE_COLLECTION = LIVE
CALIBRATION_APPLICATION = INTENTIONALLY_DEFERRED
CALIBRATION_CONFIDENCE = null
CALIBRATION_APPLIED_TO_LIVE = NO
```

No calibration score, confidence ratio, weighting, prompt adjustment, expectation mutation, or interpretation mutation was added. A future application phase requires a separate product decision that historical calibration should affect future cognition; its design is outside this closure.

## R. Closure document and contract state

This file is the canonical current v1 engineering status. The authority contract remains the semantic source; its I.28 entry points here. The reconstructive-memory contract keeps append-only phase history and its q-48 entry points here. No duplicate v1 readiness document existed before this addition.

## S. Reopen conditions

Reopen Prediction Error v1 core only for an authority-contract violation, production regression, data corruption, security issue, or semantic inconsistency. Increased NLP coverage, enabling Matcher by default, applying Calibration, multi-home support, or durable Registry are later capability phases and do not reopen v1.

## T. Future commit candidate

```text
PREDICTION_ERROR_V1_COMMIT_MANIFEST = COMPLETE
SUGGESTED_COMMIT_SUBJECT = feat(memory): freeze single-home Prediction Error v1
STAGE_COMMIT_PUSH = NOT PERFORMED
```

The candidate is the union of H.A and H.D plus only the PE hunks in H.B. H.C and H.E are excluded. H.B paths are explicitly mixed: `communication.js`, `InternalBeyond.html`, `tests/test-all.js`, and `tests/test_chat_smoke.js` need selective PE hunks; the broad chat CSS/UI token files require a separate UI commit or later hunk extraction. BOM-only PE authority files are listed in H.A and can be committed as the bounded compatibility repair. This manifest is for future review only; nothing has been staged.

## U. Git and deployment state

The anchor remains `HEAD=64ea0a616a23acff27d03ea0172ba38372465df4`, subject `feat(memory): close production prediction error loop`. The index is empty. All unrelated dirty work remains in place. No `git add`, stage, reset, checkout, clean, stash, commit, amend, or push was run.

The installed Home Node, Bridge, Active Message, and internal server processes were not restarted. `INSTALLED_RUNTIME_NOT_RELOADED_WITH_WORKSPACE_CHANGES=YES`; this is deployment state, not a v1 code-readiness failure.

## V. Final readiness ruling

```text
P5_B3_N_STATUS = COMPLETE
PREDICTION_ERROR_V1_STATUS = ENGINEERING_CLOSED
PREDICTION_ERROR_V1_SCOPE = SINGLE_HOME_NODE
SINGLE_HOME_PREDICTION_ERROR_PRODUCTION_CHAIN = CLOSED
PREDICTION_ERROR_V1_FREEZE = FROZEN
MULTI_HOME_PREDICTION_ERROR = DEFERRED_BY_PLATFORM_DEPENDENCY
CALIBRATION_APPLICATION = INTENTIONALLY_DEFERRED
CALIBRATION_CONFIDENCE = null
TIER_A_TESTS = PASS
TIER_B_TESTS = PASS
TIER_C_RELEVANT_REGRESSIONS = PASS
GIT_DIFF_CHECK = PASS
NO_NEW_SEMANTIC_FEATURE = YES
```
