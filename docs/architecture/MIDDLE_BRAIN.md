# Middle Brain Architecture

**Status: Canonical**
**Scope: Current Middle Brain runtime architecture**

> This document describes how the Middle Brain runtime works **today**. It is not a phase report,
> a closure, or an audit. Where it references history, that is provenance only.
> Source-of-truth priority: current production code → current enforcing tests → current canonical docs /
> `DECISIONS.md` → historical records.

---

## 1. Purpose

The Middle Brain (MB) is InternalBeyond's **cognitive middle layer around the character model
generation boundary**. It does not answer the user; it prepares context before generation and
evaluates character consistency after generation.

It is responsible for:

- **pre-generation**: context organization, context compression, and the admission / local-fallback
  decision;
- **post-generation**: character-integrity evaluation, an optional single targeted rewrite, and
  derivation of side-effect policy; plus a read-only quality Judge.

It is **not**: a character reply generator, a character provider selector, a memory store or writer,
a tool executor, the Image Router executor, a provider prompt cache, or a universal prompt owner.

---

## 2. Runtime Position

Canonical implementation (browser):

| Module | Role |
| --- | --- |
| `assets/js/middle-brain.js` | facade: `IB.middleBrain`, pre/post seams, dev trace |
| `assets/js/middle-brain-config.js` | config read/write, UI binding, settings card |
| `assets/js/middle-brain-config-core.js` | config normalization, runtime predicates, projection, MB system prompt |
| `assets/js/middle-brain-policy.js` | context organization, compression, Admission Gate |
| `assets/js/middle-brain-astra.js` | MB's own network/model boundary |
| `assets/js/middle-brain-judge.js` | read-only quality observation + telemetry |
| `assets/js/middle-brain-integrity.js` | Character Integrity guard + side-effect policy |

Host adapter:

| Module | Role |
| --- | --- |
| `services/home-node/middle-brain.js` | Home Node host adapter; loads the **same** canonical implementation via UMD/global shims (`loadCanonicalMiddleBrain`) |

The Home Node module is **not a second Middle Brain**. It is an adapter that installs a configuration
reader (`globalThis.__ibMiddleBrainConfigReader`) and exposes the two seams in the same shape as the
browser (`organizeContext` / `finalizeReply`). It performs no judgment of its own.

---

## 3. Canonical Facade

`IB.middleBrain` is the single production entry point. It is assembled from frozen per-layer contracts
(`MBC.config / policy / astra / judge / integrity`) in `assets/js/middle-brain.js:336` and published at
`assets/js/middle-brain.js:351`. Architecture-significant seams are listed in §5; the facade's full key
list is implementation detail and is intentionally not reproduced here.

---

## 4. Canonical Execution Flow

```text
Caller (single chat / group chat / Role DM / Home Node execution)
  │  context snapshot / dialogue / selected context
  ▼
IB.middleBrain  ·  middleBrainExecute / middleBrainCompressPipeline
  ├─ organize   (memory / understanding / thread / moments / dialogue)
  ├─ compress   (dedupe + priority + budget)
  └─ admission  ── Astra ──► (Astra cognitive compression)
                └─ local  ──► (local compressed context)
                └─ bypass ──► (return null; caller keeps its own context)
  ▼
compressedContext
  ▼
Caller performs final injection        ← injection authority is the caller
  ▼
IBModelCore / character provider        ← character model execution
  ▼
candidate reply
  ▼
IB.middleBrain  ·  middleBrainFinalizeReply
  ├─ integrity judge
  ├─ sensitivity gate
  ├─ optional targeted rewrite (at most one)
  └─ optional verify (observation only)
  ▼
reply + outcome {verdict, rewritten, reason}
  ▼
side-effect policy gates (consumer-applied)
```

MB **composition**, **caller injection**, and **model execution** are three distinct stages:

> Middle Brain returns a compressed context. Whether — and how — it is injected into the character
> model request is decided by the caller. The caller also owns the final character request.

---

## 5. Canonical Seams

| Seam | Canonical Entry | Responsibility | Does Not Own |
| --- | --- | --- | --- |
| Pre-generation | `middleBrainExecute` (`middle-brain.js:201`) | readiness check + pipeline | context injection |
| Pre-generation (pipeline) | `middleBrainCompressPipeline` (`middle-brain.js:147`) | organize → compress → admission/Astra | context injection, character request |
| Post-generation | `middleBrainFinalizeReply` (`middle-brain.js:231`) | integrity guard; returns `{reply, outcome}` | reply generation, retry |
| Side-effect policy | `middleBrainSideEffectAllowed` | allow/suppress decision from verdict | executing the side effect |
| Group memory policy | `middleBrainGroupMemoryPolicy` | group memory scope decision | memory persistence |
| Suppression snapshot | `middleBrainSideEffectSuppression` | read suppression record for the turn | enforcement |
| Config decision | `middleBrainReasoningEffort` | canonical reasoning value | provider translation |
| Config decision | `middleBrainImageMode` | canonical image policy decision | image execution |

---

## 6. Layer Architecture

```text
config  →  policy  →  astra  →  judge / integrity  →  facade
```

- **config** (`middle-brain-config.js`, `-config-core.js`): configuration normalization, runtime
  predicates, canonical config projection, MB system prompt constant.
- **policy** (`middle-brain-policy.js`): context organization into four categories
  (memory / understanding / thread / moments) plus dialogue, local compression, and the Admission
  Gate (local, deterministic, no LLM; decides whether to spend an Astra call).
- **astra** (`middle-brain-astra.js`): MB's own network/model boundary — request/response
  normalization and the Astra calls used for compression, judging, and rewriting.
- **judge** (`middle-brain-judge.js`): read-only quality observation of the compressed result +
  telemetry. Default off; never changes the execution result.
- **integrity** (`middle-brain-integrity.js`): character consistency, verdict, targeted rewrite, and
  side-effect policies.
- **facade** (`middle-brain.js`): assembles and publishes `IB.middleBrain`.

Each layer depends only on upstream layers (DAG); per-layer exports are frozen contracts.

---

## 7. Historical Terminology Warning

Historical P11 material uses "five layers" differently from the current architecture.

- **Current physical architecture** (five functional layers + facade):
  `config / policy / astra / judge / integrity` + `facade`.
- **Current integrity dimensions** (six): `persona / speech_style / relationship /
  emotional_continuity / knowledge_boundary / behavior`.

Do not merge the two, and do not call `persona / relationship / emotion / knowledge / speech` the
"Middle Brain five-layer architecture". That is a historical terminology drift, not the current
structure.

---

## 8. Context Responsibility

| Context | Authority | MB Role |
| --- | --- | --- |
| memory | other runtime | read / compress |
| understanding | other runtime | read / compress |
| thread | other runtime | read / compress |
| moments | other runtime | read / compress |
| dialogue / history | caller | read / compress |
| persona (nickname / bio / relationship / role prompt) | caller | integrity **evidence** only |
| role system instruction | caller | not owned |
| MB system instruction | MB | own Astra calls only |
| attachments / images | caller | not owned |
| tools | caller / runtime | not owned |

Core invariant: **visibility is not authority.** Middle Brain may read a context without owning it.
Ownership stays with the runtime or caller that produced it.

---

## 9. Character Integrity

Character Integrity is the post-generation guard. It is a policy + validator + targeted rewriter, not
a filter or a composer.

**Dimensions (six, `middle-brain-integrity.js:28`):** `persona`, `speech_style`, `relationship`,
`emotional_continuity`, `knowledge_boundary`, `behavior`.

**Verdicts (`middle-brain-integrity.js:82`):** `PASS`, `OOC`, `UNDECIDED`, `BYPASSED`.

**Flow:** candidate → judge → sensitivity gate → optional targeted rewrite → optional verify →
final reply + outcome.

Current invariants (production-backed):

- rewrite is attempted **at most once** per candidate;
- verify is **observation only** and never performs a second rewrite;
- timeout / error / malformed judge output is **never coerced** into `PASS` or `OOC`; it yields
  `UNDECIDED`;
- failures never fail the turn — the candidate is passed through;
- Character Integrity is **disabled by default** (`characterIntegrityEnabled:false`);
- the voice surface is currently **explicitly bypassed** (`voice_surface` skip).

`UNDECIDED` is not `OOC`; `BYPASSED` is not `PASS`.

---

## 10. Side-Effect Boundary

The integrity outcome is not only a text result. The verdict feeds current downstream policy seams:

- `middleBrainSideEffectAllowed` — per-site allow/suppress decision (`MB_CI_SIDE_EFFECT_SITES`;
  four adjudication points: mem_ops, calendar, blog_read, ws_ops);
- `middleBrainSideEffectSuppression` — per-turn suppression record across categories
  (memory, calendar, blog_read, workspace, file_archive, tool_continue);
- `middleBrainGroupMemoryPolicy` — group memory scope decision (writable scope is `private_role`).

Middle Brain **provides a policy decision**; the downstream consumer performs the actual execution or
suppression. MB does not control all side effects.

---

## 11. Configuration Authority

Canonical storage: IndexedDB `apiSettings['middle_brain']`. Architecture-significant fields:

| Field | Meaning | Default |
| --- | --- | --- |
| `enabled` | MB runtime switch (see §12) | `false` |
| `endpoint` / `model` / `apiKey` | MB's own model channel | OpenAI Responses URL / `gpt-6-astra` / `''` |
| `reasoningEffort` | canonical thinking depth (see §15) | `auto` |
| `speed` | MB service/latency tier | `standard` |
| `imageMode` | Image Router policy decision | `auto` |
| `admissionEnabled` | Admission Gate on/off | `true` |
| `middleBrainJudgeEnabled` | quality Judge on/off | `false` |
| `characterIntegrity*` | integrity enable / sensitivity / rewrite / verify | `false` / `conservative` / `false` / `false` |

`apiKey` is a credential boundary and is never projected to another host (§14).

---

## 12. Enabled State

`middleBrainRuntimeEnabled(config)` (`middle-brain-config-core.js:147`) is the **single canonical
runtime predicate**:

```text
enabled && non-empty(endpoint) && non-empty(model)
```

`isMiddleBrainEnabled` and the settings-card status badge read this same predicate. Note that it does
**not** include `apiKey`; Astra readiness is the separate predicate `middleBrainApiReady`
(`enabled && endpoint && model && apiKey`).

The historical defect "UI Enabled while runtime Disabled" is a past issue (see §25), not current
behavior.

---

## 13. Save / Immediate Semantics

The settings card is a configuration surface. Two save semantics coexist:

- **Save-to-apply**: `enabled`, `endpoint`, `apiKey`. Saving is the only point that updates the runtime
  mirror.
- **Immediate persistence**: `model`, `reasoningEffort`, `speed`, `imageMode`, and the integrity fields
  persist on pick.

A pristine/runtime snapshot backs the saved/unsaved display. This section documents the configuration
surface, not MB runtime architecture.

---

## 14. Cross-Host Projection

Execution configuration is projected Browser → Home Node through an explicit allow-list:

- `MB_EXECUTION_KEYS` (`middle-brain-config-core.js:217`) — nine keys;
- `projectExecutionConfig` (`middle-brain-config-core.js:228`) — constructive, per-field, no arbitrary
  fallback.

> **`apiKey` is not projected.** The Home Node therefore never receives the desktop MB credential.
> Consequently `middleBrainApiReady` is false on the Home Node, the Admission Gate resolves to
> `astra_not_ready`, and the Home Node runs the **local pipeline** via the same canonical core.

This is an intentional host boundary, not a missing feature.

---

## 15. Reasoning Boundary

```text
UI
 → reasoningEffort (canonical config)
 → MB canonical config
 → Astra request builder
 → IBModelCore adapter
 → provider-specific translation
```

Canonical enum: `auto / low / medium / high / max` (`middle-brain-config-core.js:161`).

- **MB owns** the canonical reasoning value.
- **MB does not own** provider-specific reasoning translation. `middle-brain-astra.js:73-91` produces
  only the canonical value; provider capability translation happens at the provider request builder
  (`IBModelCore` / `provider-directory.js`).
- `reasoning_effort` (provider snake_case) is **not** MB canonical storage; MB emits only the official
  `service_tier` for the fast tier.

---

## 16. Provider Boundary

Two distinct provider concepts:

- **MB own model channel** — MB holds its own `endpoint` / `model` / `apiKey`, used for compression,
  judging, and integrity rewrite. Its transport normalizes via `IBModelCore`'s Astra adapter.
- **Character provider** — the character reply provider/model is **not controlled by MB**; it belongs
  to the caller, `IBModelCore`, and the provider directory.

> Middle Brain having its own model channel does not make Middle Brain the owner of character model
> routing.

---

## 17. Memory Boundary

Middle Brain **reads selected context**, **compresses** it, and **returns** the compressed context. It
does **not** hydrate memory, own canonical memory storage, perform consolidation, write memory, or own
the retrieval lifecycle.

When memory context is unavailable it is recorded as missing and MB continues (empty / local / bypass).
This resilience behavior does not make MB a memory component.

---

## 18. Image Router Boundary

`middleBrainImageMode` returns the canonical image policy decision only (`fast / auto / precision`).
Middle Brain does not select an image provider, execute generation, manage Image Router credentials,
or perform image requests. The Image Router is the executor.

---

## 19. UI Boundary

The Middle Brain settings card is a **configuration surface**, not the Middle Brain runtime. The card
is responsible for configuration, saved/unsaved display, collapse state, and status display. Runtime
authority lives in the canonical MB modules.

User-facing surfaces are outside the ownership of the Middle Brain runtime architecture.

---

## 20. Diagnostics / Observability

- **Home Node diagnostics** (`services/home-node/middle-brain.js`): availability, load status, installed
  shims, layer contract keys, facade key count, snapshot-contract presence, config-reader state. It
  contains no configuration content and no credentials.
- **Judge telemetry**: read-only quality counts and latency.
- **Integrity telemetry**: verdict counts, judge/rewrite/verify counters, suppression counters.
- **Dev trace**: `IB.__mbTrace` is a **dev-only** in-memory ring. It records state, flags, counters, and
  selected metadata (verdict/reason, group scope ids, suppression categories). It does **not** record
  reply body or memory content.

---

## 21. Consumer Matrix

| Consumer | MB relationship | Notes |
| --- | --- | --- |
| Single chat | full `execute` / `finalize` + side-effect gates + reasoning | canonical |
| Group chat | `execute` / `finalize` + group memory policy | intentional scope difference |
| Role DM | `execute` / `finalize` | canonical |
| Home Node (mobile backend) | same canonical core, local path | no MB credentials |
| Image Router | decision-only (`imageMode`) | executor is the Router |
| Active Companion | currently not integrated (no direct MB call) | current fact |
| Diary | currently not integrated (no direct MB call) | current fact |
| Moments | currently not integrated (no direct MB call) | current fact |
| Voice | integrity bypass | intentional |

"Currently not integrated" describes the present implementation. It does not define a permanent
product prohibition.

---

## 22. Non-goals

Middle Brain does not currently own:

- character provider selection;
- character model execution;
- role system-prompt authority;
- memory persistence or consolidation;
- tool execution;
- image execution;
- provider prompt cache, stable-prefix construction, cache baselines, or cache audit telemetry;
- global side-effect execution.

The current non-integration of Active Companion / Diary / Moments does not by itself define a
permanent prohibition. User-facing surfaces are outside this architecture's ownership.

---

## 23. Enforcement

Runtime behavior is enforced by targeted tests; this document is the human canonical architecture
authority. No new Markdown parser is added.

| Concern | Key tests |
| --- | --- |
| Execution / convergence | `test_middle_brain_seam.js`, `test_middle_brain_convergence.js`, `test_middle_brain_convergence_counterproof.js` |
| Context / admission | `test_middle_brain_ctx.js`, `test_middle_brain_admission.js` |
| Integrity / side effects | `test_middle_brain_integrity.js`, `test_middle_brain_integrity_state.js`, `test_middle_brain_integrity_notice.js`, `test_middle_brain_side_effect_gate.js`, `test_middle_brain_calibration.js` |
| Configuration / enabled | `test_middle_brain_semantics.js`, `test_middle_brain_collapse.js` |
| Reasoning | `test_middle_brain_reasoning_effort.js` |
| Observability | `test_middle_brain_observability.js`, `test_middle_brain_trace.js` |
| Home Node assembly | `test_home_node_middle_brain_assembly.js` |

---

## 24. Historical References

Historical documents describe implementation evolution. `MIDDLE_BRAIN.md` describes current
architecture; historical files no longer carry current authority.

- `docs/history/runtime/P11-3-MIDDLE-BRAIN-SEMANTICS-CLOSURE.md`
- `docs/history/runtime/CONTEXT-CONVERGENCE-C1-REPORT.md`
- `docs/history/runtime/P2-CONTEXT-CONVERGENCE-AUDIT.md`
- `docs/history/platform/ASTRA_READINESS_PHASE1.md`
- `docs/history/runtime/RUNTIME-STABILIZATION-P2-REPORT.md`
- `docs/history/runtime/RUNTIME-INTEGRATION-AUDIT-2026-09-08.md`
