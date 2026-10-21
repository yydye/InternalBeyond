# Memory Association Contract

**Status: Canonical**
**Scope: P21-R3 Memory-to-Memory Activation & Tension**
**Implementation status: FROZEN**

This contract defines a runtime-derived relationship view over canonical Memory.
It does not add fields to MemoryRecord, a relation table, a graph store, or a
second Memory authority.

## 1. Authority and identity

- Home Node memory_records remains the canonical durable Memory authority.
- Association reads the same canonical store through a bounded Home Node seam,
  reuses the shared visibility and ranking core, and rechecks visibility before
  reading candidate text.
- Association preserves every memoryId; it never writes, deletes, merges, or
  rewrites a canonical record.
- Relation classification is evidence about a pair of texts. It does not decide
  factual truth, relationship state, or behavior.
- Association owns no Prediction Error, Relationship, Self Narrative, or Memory
  Interpretation write path.

The browser Memory World remains presentation-only. It does not provide runtime
association authority or draw relationship edges.

## 2. Production seam

The only production seam is the authoritative Home Node Recall path:

    canonical Recall selection
      → bounded Association expansion
      → expanded context + derived Association trace
      → existing cognition / later interpretation consumers

Association runs after direct Recall selection. selectedIds, reinforcementIds,
activation telemetry, exposure telemetry, Recall ranking, and Recall fingerprint
continue to describe direct Recall only. Associated memories carry separate
association_* activation reasons in the derived working set.

Shadow Recall does not invoke Association. An Association error, timeout, missing
credential, or invalid model response returns the direct Recall context unchanged.

The separate optional R4-C MemoryInterpretation batch continues to receive
direct Recall ids. P21-R3 does not rewrite that hook or persist a new
interpretation. The chat cognition context receives the relation-labeled
expansion, while the runtime response keeps the structured Association trace.

## 3. Candidate discovery and budgets

- Association makes one deterministic read of at most 20,000 canonical records,
  then reuses the shared Memory visibility and ranking core to produce at most 64
  source candidates, plus up to four direct Recall anchors. If the store reports
  a truncated scan, Association falls back to direct Recall.
- Association uses at most four direct anchors and selects at most six relation
  candidates.
- The closed-set classifier receives at most 12 pairs in one batch.
- The final working set is all direct Recall selections plus at most four
  associated memories.
- Expansion depth is exactly one. Candidate memories are never used to discover
  another candidate.
- Added context is at most 1,200 characters and at most half of the configured
  direct Memory character budget.
- Candidate and pair ties resolve deterministically by score, anchor order, and
  memory id.

The scan and source candidate caps bound local candidate discovery; the LLM never
searches the Memory database. Candidate discovery may use lexical overlap,
existing provenance references, and temporal proximity. Provenance can nominate
a candidate, but does not by itself assign a semantic relation.

## 4. Closed relation set

The v1 relation vocabulary is:

| Relation | Meaning |
| --- | --- |
| support | The second memory reinforces the first. |
| complement | It supplies a missing part without changing the first. |
| conflict | It creates tension in a key fact, feeling, or relationship judgment. |
| correction | It is an explicit update or correction candidate for the first. |
| continuation | It describes a later part of the same event or process. |
| contextualize | It changes how the first should be understood without negating it. |
| unrelated | No meaningful relation is established. |

Exact normalized title/body/tag text equality is mechanically classified as support.
Other pairs use the bounded semantic classifier. The classifier returns only
anchorMemoryId, relatedMemoryId, and one closed-set relation. Invalid ids, extra
fields, missing pairs, and out-of-vocabulary relations fail closed to direct
Recall.

conflict means “in tension,” not “false.” correction means “correction
candidate,” not a truth winner. A factual explanation must not invalidate or
erase the historical truth of an emotional memory.

## 5. Context and replay

Structural relation classification is context-independent and memoized in a
bounded process-local cache using both record fingerprints, relation schema
version, and model identity. Current conversation text is capped at 1,200
characters and affects only associated-memory activation ranking; it is not sent
to the relation classifier.

The result is session-derived. It is not persisted or written as a canonical
Memory. For the same turn, the Recall runtime replay memo returns the same context
and Association trace without repeating activation, exposure, or model work.

The Fathom history projection is separate from this result and from canonical
Memory relations. After a successful authoritative Recall, it may retain a bounded
event containing only the character scope, source channel, time, direct memory ids,
Association endpoint ids and relation labels, and Recall counts. It must not retain
turn text, query text, conversation ids, candidate bodies, or a writable relation
record. Fathom reads re-check current Memory visibility and never include Agent
Memory or Role DM state in the Chat history scope.

## 6. Model and failure policy

- At most one provider call per Recall, with at most 12 pairs.
- Temperature is zero; one bounded timeout is used; AUTO_RETRY = NONE.
- Model output is strict JSON with exact pair ids and exact keys.
- The prompt forbids truth adjudication, rewriting, merging, deletion,
  relationship mutation, behavior instructions, and self-narrative generation.
- Timeout, transport error, missing provider or credential, and invalid output
  fall back to direct Recall and do not fail the chat turn.

## 7. Explicit non-goals

This phase adds no durable graph, vector database, embedding infrastructure,
external graph service, semantic forgetting, shared Memory authority,
meta-memory, memory distortion, Self Narrative, or Memory World UI changes.
R4-G causal graph traversal remains outside P21-R3.

## 8. Enforcement

| Test | Coverage |
| --- | --- |
| tests/test_memory_association_core.js | Closed vocabulary, visibility, bounded depth and expansion, provenance, truth boundary, no mutation |
| tests/test_memory_association_runtime.js | One-call budget, cache, timeout, invalid output, mechanical-first, failure fallback |
| tests/test_memory_association_product_e2e.js | Authoritative Recall integration, direct activation/exposure preservation, context and replay |
