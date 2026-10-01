# MEMORY COOLDOWN CONTRACT

**Status:** Frozen (contract only — **not implemented**)
**Phase:** P21-R2-F1b0 (P21-R2-F1a is implemented in the working tree, uncommitted)
**Scope:** session-local *exposure* cooldown for the canonical chat recall pipeline
**Authority:** this document. Implementation is `R2-F1b`.

> ⚠ **This contract describes behaviour that does not exist yet.**
> `trace.cooldownFactor` is still hardcoded to `1` (`assets/js/memory-recall/recall-trace.js`).
> No `RecallSessionState` exists. Do not cite this document as evidence that cooldown is live.

---

## 1. Product definition

> **某条 Memory 刚刚被实际用于对话上下文后，在后续若干轮自动 surface 时降低再次出现的优先级，
> 避免同一记忆连续霸占上下文。**

Keywords: **exposure** · **recent turns** · **automatic surface repetition** · **session-local**.

Cooldown is **NOT**:

| not this | why |
|---|---|
| activation fatigue | fatigue reads durable activation telemetry; cooldown reads session exposure |
| decay | decay is a wall-clock function of `lastActivated`; cooldown has no clock |
| hard relevance gate | cooldown never decides *whether* a memory is relevant |
| reminisce | reminisce needs long-term dormancy; cooldown is session-local and resets |
| durable memory importance | cooldown must not change `MemoryRecord` |
| "activationCount high within 2h" | that is fatigue, and it needs `activationCount > 5` |

---

## 2. Fatigue vs Cooldown (must stay separate)

Current, **unchanged** fatigue (verified `P21-R2-F1b0`):

| | value |
|---|---|
| location | `assets/js/memory-retrieval-core.js` — inside `rankMemoryCandidates` |
| gate | `!m.pinned && m.activationCount > 5 && hoursSince(lastActivated) < 2` |
| effect | `_score = base × relBoost × fatigue`, `fatigue ∈ {1, 0.7}` |
| fields | `activationCount`, `lastActivated` (both contract `TELEMETRY_FIELDS`) |

**Frozen distinction**

| | fatigue | cooldown |
|---|---|---|
| class | durable-ish activation-derived **ranking penalty** | session-local exposure-derived **repeat penalty** |
| data source | activation telemetry | exposure records |
| clock | wall-clock hours | **turn distance** |
| triggers on | `activationCount > 5` | **the very first exposure** |
| survives refresh/restart | yes | **no (by design)** |

### 2.1 `lastActivated` MUST NOT be used as the cooldown clock

Two independent reasons, both structural:

1. **`coldStart` writes no activation.** R2-E1b froze `activationPolicy = 'none'` for coldStart.
   An anchor can be **injected and seen by the user** while `activationCount`/`lastActivated` stay
   untouched. ⇒ activation cannot observe one whole class of exposure.
2. **`recall` and `glossary` DO write activation.** Those are *explicit user requests*, not
   *automatic surfacing*. ⇒ `lastActivated` moves for reasons that are not "the system surfaced it".

The two directions disagree, so neither implies the other. **Using `lastActivated` as the
cooldown clock would be wrong in both directions at once.**

---

## 3. Authority

```text
RecallSessionState   ← the ONLY cooldown authority
```

MUST be **session / runtime-local**. MUST NOT be:

- IndexedDB · localStorage · SQLite · Home Node canonical memory
- `MemoryRecord` (any new field)
- exported / imported / backed up / migrated

MUST NOT add to durable schema: `lastSurfacedAt` · `lastRecalledAt` · `lastSelectedAt` · `lastChannel` · `lastCooldownAt`.

> **This prohibition stands until R2-H (activation authority) plus a fingerprint/migration proof
> are complete.**

---

## 4. State shape (minimal)

```js
RecallSessionState = {
  exposures: Map<ScopeKey, ExposureState>
}

ExposureState = {
  lastExposureTurn: number,   // session turn index, NOT a timestamp
  exposureCount:    number    // optional; may be omitted in v1
}

/* idempotency lives at STATE level, not per memory: */
perCharacterTurnCounter: Map<characterId, number>
browserTurnIndex:        WeakMap<turnObject, turnIndex>
homeTurnIndex:           Map<turnId, { characterId, turnIndex }>   // BOUNDED
```

#### Idempotency without unbounded growth (`P21-R2-F1b1` closure)

A per-memory `turnIds: Set` is **SUPERSEDED / REJECTED**: it duplicates the same logical turn once per memory,
with no bound, no eviction and no lifecycle rule.

**FROZEN — the simplest sufficient rule:**

```
recordExposure({ characterId, memoryIds, turnIndex }):
  for each memoryId:
    if exposures[characterId][memoryId].lastExposureTurn === turnIndex:  continue   // no-op
    set lastExposureTurn = turnIndex ; exposureCount += 1
```

`lastExposureTurn === turnIndex` is **naturally idempotent** for repeated `recordExposure` calls in
the same turn ⇒ no per-memory turn history is needed at all.

| structure | bound |
|---|---|
| `perCharacterTurnCounter` | one number per character |
| `browserTurnIndex` (WeakMap) | GC-bound by the turn object itself — no manual eviction |
| `homeTurnIndex` (Map) | **MUST be bounded**: delete the entry in the settle handler |
| `exposures[characterId]` | one entry per (character, memory) actually injected |

If a Home Node turn never settles, the existing `liveTurns` TTL sweep is the backstop.

**No wall-clock timestamp.** Cooldown v1 works on **turn distance**, not `Date.now()`:

| reason | detail |
|---|---|
| cross-host clock skew | Browser and Home Node clocks can differ |
| refresh/restart already resets | a persisted timestamp would be meaningless after reset |
| product target is "consecutive turns" | not "N minutes" |
| testability | an injected turn counter is deterministic; a clock is not |

---

## 5. Scope key

```text
exposures: Map<characterId, Map<memoryId, ExposureState>>     ← FROZEN (nested maps, NO string key)
```

| case | result |
|---|---|
| same character + same memory + same conversation | shared |
| **same character + same memory + DIFFERENT conversation** | **SHARED** |
| **different character + same memoryId** | **ISOLATED** |
| same conversation + different memory | isolated |
| Browser page refresh | **RESET** |
| Home Node process restart | **RESET** |

> ❌ **SUPERSEDED.** The earlier F0 test-matrix entry *"different conversation isolated"* was **WRONG** and is
> superseded by this table. It must not reappear in any F1b test.

#### Why nested maps and not a concatenated string key

A flat `characterId + ":" + memoryId` key is **collision-prone**: `("a:b", "c")` and `("a", "b:c")`
produce the same string. Audited (`P21-R2-F1b1`):

- `MEMORY_RECORD_CONTRACT.md` constrains `id` only as "必填、非空、≤ 200 字符" — **no character-set
  restriction**, so a colon is not forbidden;
- production generators happen to be colon-free today (`mem_<ts>_<rand>`, `map_<base36>_<base36>`)
  and `characterId` is an opaque id — but **nothing enforces this**.

⇒ **FROZEN: use nested maps.** Never hand-concatenate a scope key, and do not add a new id encoder.

Rationale: the product target is *"the same character should not keep re-raising the same memory"*.
Switching threads/conversations must **not** reset that perception. Different characters are already
isolated by ACL, so `characterId` is the natural foreign key.

**Candidate keys considered and rejected**

| candidate | verdict |
|---|---|
| `memoryId` only | ❌ cross-character false suppression |
| `conversationId + memoryId` | ❌ too narrow: a new thread would reset cooldown |
| `channel + conversationId + memoryId` | ❌ conflates bypass semantics into the key |

### 5.1 Browser `characterId` forensics (verified)

All production `getMemoryContext` / `selectMemoryContext` callsites pass a **role/character id**:

| callsite | argument | actual semantic | usable |
|---|---|---|---|
| `communication.js:1709` (single chat / thread) | `cfg.id` | role config | **YES** |
| `communication.js:1909` (**group** chat) | `cfg.id` | role config (speaker); `group.id` is used *separately* for `conversationId` | **YES** |
| `communication.js:59` (blog comment) | `cfg.id` | `apiConfigs.find(a => a.id === aiId)` → role | **YES** |
| `memory.js:918` (write-one-line) | `cfg.id` | role that authored the memory | **YES** |
| `middle-brain-policy.js:66` | `characterId` | role | **YES** |
| `role-dm.js:565` | `speakerId` | role (`cfgOf(speakerId)`, `relationGet(speakerId,…)`) | **YES** |
| `communication/letters.js:259` | `cfg.id` | `apiConfigs.find(a => a.id === id)` → role | **YES** |
| `communication/annotations.js:141` | `cfg.id` | `_annoSelectedAI` → role | **YES** |
| `game/game_story.js:269` | `G._aiCfg.id` | role config | **YES** |
| `game/game_tarot.js:550` | `cfg.id` | role config | **YES** |
| `game/game_tea.js:796` | `G._teaCfg.id` | role config | **YES** |

**Decisive corroboration:** in the group path the codebase itself writes
`characterId: String((cfg && cfg.id) || '')` (`communication.js:1980`), and derives the
conversation id separately as `_ibConvId(String(group.id||''), opts.threadId||null)`
(`communication.js:1922`). ⇒ **character id and group id are distinct and never conflated.**

### 5.2 Home Node `characterId` forensics (verified)

```text
mobile payload.characterId
  → parseSendPayload            mobile-gateway.js:823   characterId = String(payload.characterId||'').trim()
  → conversationIdFor(characterId, threadId)            mobile-gateway.js:872/904/935/942
  → beginTurn                   mobile-gateway.js:1116  characterId: parsed.characterId
  → buildRuntimeContext         mobile-gateway.js:1023  (character && character.id) || ctx.characterId || ''
  → memory-retrieval.retrieve   memory-retrieval.js:70  const roleId = String(characterId)
  → orchestrator options.apiId
```

- `conversationId` is **derived from** `characterId` + `threadId` ⇒ `characterId` is stable across
  DM / thread / Android; only the conversation id varies.
- `memory-retrieval.js` names it `roleId`, and it is the ACL `apiId`.
⇒ **stable role id across the whole chain. Usable as the cooldown `characterId`.**

---

## 6. Channel matrix (obey / bypass / write)

| channel | obey cooldown? | write exposure? |
|---|---|---|
| `surface` | **OBEY** | **WRITE** |
| `recall` | **BYPASS** | **WRITE** |
| `glossary` | **BYPASS** | **WRITE** |
| `coldStart` | **BYPASS** (no read) | **WRITE** |
| `reminisce` | n/a — still `FUTURE` | n/a |

### 6.1 `surface` — obey
Automatic surfacing is the exact thing cooldown exists to de-duplicate. Core path.

### 6.2 `recall` — bypass
The user explicitly asked to remember. Refusing because "it appeared recently" would be **lying to
the user**.

### 6.3 `glossary` — bypass
The user explicitly named an alias/term. A deterministic lookup must never be hidden by cooldown.

### 6.4 `coldStart` — bypass read, but write
ColdStart is a first-turn lifecycle restore; its target is **stable continuity, not variety**.
It must not be blocked or re-ranked by cooldown. But:

> **no activation ≠ no exposure.**

A successfully delivered anchor was *seen by the user*, so it MUST be recorded — otherwise a new
conversation would re-seed the same anchors forever and a later `surface` could never cool them down.

> **Decision (frozen): option A — ColdStart does not READ cooldown, only WRITES exposure.**
> Consequence, accepted: creating several new conversations in a row will keep seeding the same
> pinned anchors. That is the intended meaning of "stable anchor restore". Rotating anchors would
> require dormant/long-unsurfaced authority, which does not exist (→ §11).

### 6.5 `reminisce` — n/a
Stays `FUTURE`. See §11.

### 6.6 `bypass selection ≠ bypass exposure recording`

`recall` and `glossary` bypass the *penalty* but still **write** exposure. The user just saw those
memories; the next `surface` turn should be less likely to repeat them.

---

## 7. Penalty form — multiplicative, never a gate

```text
canonical ranking contribution = existing canonical score × cooldownFactor
0 < cooldownFactor <= 1
```

| option | verdict |
|---|---|
| A. hard suppress (factor 0 / removal) | ❌ a candidate pool of 1 would produce an empty block; cooldown must not decide *whether* |
| **B. multiplicative factor** | ✅ **FROZEN** |
| C. rank offset | ❌ incomparable units against `base × relBoost × fatigue`; not scale-free |

`cooldownFactor` MUST be `> 0`. A cooldown'd memory may still be selected when the pool is small —
that is intended: cooldown lowers the *probability of repeated dominance*, not existence.

---

## 7.5 Selector injection contract (`P21-R2-F1b1`)

The orchestrator has **no legal position** to apply the factor: it only sees the gated list before
`core.buildMemoryContext` (`memory-recall-orchestrator.js:654`) and the finished result after it.
Multiplying there would require re-sorting ⇒ **a second selector**, which is forbidden.

**FROZEN: a single pure-data core option.**

```js
buildMemoryContext(records, {
  ...
  cooldownFactorsById: { memA: 0.4, memB: 1 }   // optional; absent ⇒ no cooldown
})
```

Why this option:

| option | verdict |
|---|---|
| A. orchestrator writes a temp field onto `MemoryRecord` | ❌ mutates canonical records; purity + fingerprint risk |
| **B. `cooldownFactorsById` (pure data map)** | ✅ **FROZEN** — core stays the only ranking/selection authority; session state never enters core; core never needs `characterId`; absent ⇒ legacy behaviour; exploration reads the same factor; trivially injectable |
| C. `scoreFactor(memoryId)` callback | ⚠ works, but passes a function into core — harder to serialise/compare in traces and fixtures |
| D. orchestrator pre-sorts and hands over | ❌ **second selector** — explicitly forbidden |
| E. policy object / rank callback | ❌ over-general; invites reimplementing ranking outside core |

**Fail-safe (FROZEN).** An invalid factor MUST NOT make a memory disappear:

| input | effective factor |
|---|---|
| option absent / not an object | `1` |
| id missing from the map | `1` |
| value not a finite number (`NaN`, `Infinity`, string, object, `null`) | `1` |
| `factor <= 0` | `1` |
| `factor > 1` | `1` |

`0 < factor <= 1` is the only accepted domain. Anything else degrades to "no cooldown" — never to
"excluded".

**Placement inside core** (verified line references, post-F1a):

| what | where |
|---|---|
| `base = getMemoryScore(m)` | `core:94` (pinned ⇒ 999) |
| `relBoost` | `core:166` |
| `fatigue` | `core:168-171` |
| **factor applied** | **`core:175`** — `_score = base x relBoost x fatigue x factor` |
| pinned/unpinned split | `core:209-210` ⇒ becomes `_effPinned` |
| exploration pool | `core:241` ⇒ additionally filters `factor === 1` |

**Trace must not drift from the value core actually used.** Preferred: the orchestrator already owns
the map and passes the same value into the trace — **no new public result field, no `CANDIDATE_KEYS`
growth**. A test MUST assert `trace.cooldownFactor === coreFactor` for every candidate; it is not
acceptable for the orchestrator to report `0.4` while core used `1`.

> Core→orchestrator selection metadata is the fallback only if the orchestrator cannot reconstruct the
> map. Prefer the map it already holds.

## 8. Pipeline insertion point

```text
candidate set
  ↓ ① visibility / ACL                    ← unchanged, MUST stay first
  ↓ ② query construction / relevance      ← unchanged
  ↓ ③ scoring (getMemoryScore)            ← unchanged
  ↓ ④ fatigue                             ← unchanged (core, activation-derived)
  ↓ ⑤ Hard Gate                           ← unchanged
  ↓ ⑥ cooldownFactor                      ← ★ INSERT HERE
  ↓ ⑦ canonical ranking (sort by _score)
  ↓ ⑧ exploration (FULL-REMAINING uniform)
  ↓ ⑨ budget (payload budget, header pre-deducted)
  ↓ ⑩ seat allocation (pinned → exploration reserve → primary)
  ↓ ⑪ rendered context
  ↓ ⑫ trace
```

Constraints (MUST):

- **after** the candidate is admitted (ACL + Hard Gate) — a non-admitted memory must never be
  scored or traced;
- **before** canonical ranking decides — otherwise it cannot affect selection;
- **never** after the seat planner — a post-seat penalty cannot influence what is selected;
- **never** before ACL — a hidden memory must not be observable through cooldown state.

> The existing implementation order is `… gate → budget(main+exploration) → seat cap`, i.e. seat
> runs after selection. This contract inserts cooldown **before ranking**, which is compatible with
> both the contract diagram and the implemented order. See `R2-F1a-PIPELINE-DOC-1` (§13).

---

## 9. Factor policy

### 9.1 Shape (FROZEN)

```text
distance = currentTurnIndex - lastExposureTurn
```

| condition | factor |
|---|---|
| no exposure record | `1` |
| `distance <= 0` | `1` (same turn / stale) |
| `distance == 1` | `< 1` (strongest penalty) |
| `1 < distance < recoveryTurns` | `≤ 1`, monotonically non-decreasing |
| `distance >= recoveryTurns` | exactly `1` |

**Invariants (MUST hold, testable):**

```text
0 < factor(distance) <= 1                                  (never zero, never > 1)
factor(1) < factor(2) <= 1                                 (monotonic recovery)
factor(distance >= recoveryTurns) === 1                    (bounded recovery)
factor is deterministic given (distance, policy)
factor does not depend on wall-clock time
```

### 9.2 Candidate schemes

| scheme | explainability | determinism | test cost | tuning debt | effect on exploration |
|---|---|---|---|---|---|
| **A. 2-turn cooldown** (`f(1)=p`, else 1) | highest — "one turn off" | trivial | lowest (2 cases) | 1 number | mild: only the immediately-next turn is affected |
| **B. 3-turn recovery** (`f(1)<f(2)<1`) | high — "cools over 2 turns" | trivial | low (3 cases) | 2 numbers | stronger smoothing |
| C. exponential recovery `f = p + (1-p)(1 - e^{-k·d})` | lowest — needs `p`,`k` and hand-waving | deterministic but float-sensitive | medium (needs tolerance) | 2 numbers + float policy | most gradual |

### 9.3 Recommendation

> **FROZEN: scheme B (discrete, 3-turn recovery) with `factor(1) = 0.40`, `factor(2) = 0.70`,
> `recoveryTurns = 3` — i.e. policy P2.**

Reasons: discrete and small-state (matches §4); integer-comparable in tests (no float tolerance);
monotonic recovery expressible as `f(1) < f(2) <= 1`; and it avoids the "one turn off then fully
back" cliff that makes scheme A feel arbitrary while adding only one extra number over A.

#### Calibration evidence (`P21-R2-F1b1`)

Discriminating fixtures (score ratio `C/S` chosen so different policies flip `selectedIds`);
6 of 10 fixtures discriminated.

| fixture | design | policy grouping |
|---|---|---|
| K1 | `C/S = 0.45`, distance 1 | `{P1,P2}` vs `{P3,P4}` |
| K2 | `C/S = 0.35`, distance 1 | `{P1}` vs `{P2,P3,P4}` |
| K3 | `C/S = 0.55`, distance 1 | `{P1,P2,P3}` vs `{P4}` |
| K4 | `C/S = 0.65`, distance 2 | `{P1}` vs `{P2,P3,P4}` |
| K5 | `C/S = 0.78`, distance 2 | `{P1,P2,P3}` vs `{P4}` |
| K8 | seat cap 3, 5 competitors | `{P1,P2,P3}` vs `{P4}` |
| K6 | distance 3 | all identical to no-cooldown (recovery boundary proven) |
| K7 | cooled pinned + 2 normals | all identical (structural, not calibration) |
| K9 | single eligible, cooled | all inject it (not a hard gate) |
| K10 | exploration with cooled items | all exclude cooled from the pick |

Recovery profile (`recent` base 11.8):

| policy | f(1) | f(2) | d1/base | d2/base |
|---|---|---|---|---|
| P1 | 0.25 | 0.60 | 25% | 60% |
| **P2** | **0.40** | **0.70** | **40%** | **70%** |
| P3 | 0.50 | 0.75 | 50% | 75% |
| P4 | 0.60 | 0.80 | 60% | 80% |

**Why P2 and not stronger (P1 = 0.25).** At 0.25 any alternative scoring above 26% of the cooled
memory displaces it (fixture K2, `C/S = 0.35`). That overrides importance/emotion/decay beyond what
"do not repeat" warrants, and 25% of base approaches a soft hard-gate — contradicting §7.

**Why P2 and not weaker (P4 = 0.60).** At 0.60 only alternatives above 60% overtake (K1 `0.45` and
K3 `0.55` keep the cooled memory first). The observable effect nearly vanishes in exactly the
"reasonable alternative exists" case that motivates cooldown.

**P2 sits on the decision boundary**: at `C/S = 0.45` the alternative wins (K1), at `C/S = 0.55` the
cooled memory holds (K3) — the intended reading of "a reasonably-scored alternative rises, a weaker
one does not". P3 (0.50 / 0.75) is the documented conservative fallback if the product prefers the
cooled memory to hold at `C/S = 0.45`.

> Only two numbers are introduced (0.40, 0.70) plus the integer `recoveryTurns = 3`.
> Values are integer-exact in tests — no float tolerance required.

---

## 10. Interaction with exploration (FROZEN decision)

Exploration samples **uniformly over the full remaining pool** (R2-F1a). A memory that was just
penalised by cooldown is still in that pool, so it could be drawn straight back.

**Without a rule, cooldown would be defeated by its own exploration.** Two options:

| option | verdict |
|---|---|
| A. cooldown only affects primary ranking; exploration may re-draw a recent memory | ❌ directly defeats the product goal |
| **B. a recent-cooldown candidate stays in the candidate set but is excluded from being an exploration PICK until `factor` returns to 1** | ✅ **FROZEN** |

**This is NOT a Hard Gate.** The candidate:

- remains admitted (never removed by ACL/gate semantics),
- remains in the canonical ranking and may still be selected normally,
- is merely **not eligible to be the single exploration draw**.

Implementation consequence: the exploration pool becomes
`remaining.filter(c => cooldownFactor(c) === 1)`. If that filter empties the pool, **no exploration
item is produced for that turn** (do NOT fall back to sampling a penalised candidate, and do NOT
re-draw).

---

## 11. Pinned and coldStart interaction

### 11.1 Pinned — the multiplicative factor alone is structurally inert

`P21-R2-F1b1` reproduced the contradiction with real fixtures. Two independent mechanisms make a
naive "pinned obeys cooldown via `factor`" impossible:

| # | mechanism | evidence (real `selectedIds`) |
|---|---|---|
| 1 | the pinned loop selects by `m.pinned` and **never reads `_score`** (`core:209` split, `core:215` loop) | with `factor(P)` from `1` down to `0.01`, `selectedIds` stayed `[P,N1,N2]` — even when P sorted **last** |
| 2 | `getMemoryScore` returns `999` for pinned (`core:94`) | `999 x f` still beats a normal memory scoring `14.15` for every `f >= 0.02` |

> A cooled pinned ranked as `999 x f` would still dominate. **Calibration cannot fix a structural
> problem** — no choice of `f` removes mechanism 1.

**FROZEN (corrected): a cooled pinned loses BOTH privileges.**

```
effectivePinned(m) = m.pinned === true AND cooldownFactor(m) === 1
scoreSource(m)     = effectivePinned(m) ? 999 : getMemoryScore({...m, pinned:false})
_score(m)          = scoreSource(m) x relBoost x fatigue x cooldownFactor(m)
```

When cooled, a pinned memory:

- is ranked **as an ordinary memory** (its non-pinned score, times the factor), and
- is processed in the **normal loop**, not the pinned loop.

When the factor returns to `1` it **automatically regains** both privileges. This is a **per-turn
effective classification, never a durable mutation** — `MemoryRecord.pinned` is untouched.

**Verified behaviour** (pinned `P` importance 10 → non-pinned score 11.8; normals 14.15 / 12.97):

```
factor(P)=1     selectedIds=[P,N1,N2]     (baseline: pinned first)
factor(P)=0.4   selectedIds=[N1,N2,P]     (demoted, STILL INJECTED - not a hard gate)
```

`recall`/`glossary` bypass at the channel level, so pinned needs no extra privilege there.

Note: pinned still **skips fatigue** while it remains effective-pinned (`core:169`). Unchanged and
unrelated — fatigue is activation-derived, cooldown is exposure-derived.

**Seat label (audited, FROZEN): a cooled pinned that is selected keeps `seat = "pinned"`.**
`seat-planner.seatLabel(record)` reads `record.pinned === true`, and the record is never mutated, so
this holds automatically with no code change. Rationale: `seat` describes the memory's
**identity / product label**, not this turn's ranking privilege.

### 11.2 coldStart

Per §6.4: coldStart does **not read** cooldown but **writes** exposure for the anchors it actually
injected. A pinned anchor therefore continues to be restored on every new conversation (by design)
while still being cooled down for subsequent `surface` turns.

### 11.3 Reminisce

Stays `FUTURE`. See §12.

---

## 12. Reminisce dependency (BLOCKED)

`reminisce` remains the only `FUTURE_CHANNELS` entry and MUST NOT be implemented on session cooldown.

> **"factor has recovered to 1" ≠ "long unsurfaced".**

After a Browser refresh or a Home Node restart **all** session state is empty, so every memory is
equally "not recently surfaced". Any dormancy/long-unsurfaced signal built on session state would be
**false** exactly when it mattered most.

Reminisce therefore requires **durable exposure history**, which this contract forbids until
**R2-H (activation authority)** plus a fingerprint/migration proof. It MUST NOT be faked with a
"random low-score memory".

---

## 13. Write semantics

### 13.1 What may be written

Exposure may be recorded **only** for memories that ended up in the **final injected result**.

MUST NOT write for:

| case | why |
|---|---|
| hidden (ACL-rejected) | never entered the pipeline; writing would leak existence |
| gate-rejected | not relevant this turn |
| core-selected but **dropped by the seat cap** | never reached the prompt |
| budget-rejected | never reached the prompt |
| exploration candidate that was **not** finally injected | never reached the prompt |
| any turn with `result.count === 0` | nothing was injected |

The write source is:

```text
FINAL INJECTED ids   (result.selected / injectedIds)
```

**NEVER**: candidate ids · core pre-seat ids · `reinforcementIds`.

> Rationale: `reinforcementIds` is **empty for coldStart** (`activationPolicy='none'`). Attaching
> cooldown to `reinforcementIds` would silently drop all coldStart exposure — precisely the case
> §6.4 requires us to record.

### 13.2 Exposure write ≠ activation

The two are deliberately decoupled:

| | activation / reinforcement | cooldown exposure |
|---|---|---|
| source ids | `reinforcementIds` | **final injected ids** |
| coldStart | suppressed | **recorded** |
| recall / glossary | recorded | recorded |
| purpose | ranking (durable) | de-duplication (session) |

---

## 14. Timing

### 14.1 Browser — narrowest success seam

Verified request chain: `buildChatContext` → `callApiChatStream` / `callApiChat` → `_callApiChat*Once`
→ `_ibFetch` (documented as the **single LLM POST entry**).

| candidate seam | verdict |
|---|---|
| A. context build succeeded | ❌ current `recordMemoryActivation` timing — writes even if the request never leaves |
| B. fetch Promise created | ❌ no evidence the request reached the provider |
| C. **HTTP success (`response.ok`)** | ✅ acceptable floor |
| D. **first token / stream open** | ✅ **recommended** — proves the model actually began responding |
| E. response complete | ✅ strongest, but couples cooldown to full completion incl. user cancels |

> **FROZEN: D (first token / stream open), falling back to C for non-streaming calls.**
>
> The write MUST fire **exactly once per logical turn** — a one-shot guard around the first
> successful token. The internal retry loop lives **inside** `callApiChatStream` / `callApiChat`,
> so a naive per-attempt hook would write on every retry; the guard must be bound to the
> **logical turn** (`_ibTurn`), not to the attempt.
> Cooldown MUST NOT reuse the current pre-request activation timing.

### 14.2 Home Node

`runTurn(turn).then(settled => …)` with gate `settled.status !== 'error'` — already the correct
success seam. Cooldown exposure SHOULD be written there, from **final injected ids**, in the same
place as (but independent of) reinforcement.

```
coldStart turn:
  reinforcementIds = []      → no activation        (unchanged)
  exposureIds      = anchors → exposure RECORDED    (new, and required)
```

---

## 15. Retry / cancel / error

### 15.1 Idempotency

**One logical user turn ⇒ at most one exposure write.** A provider retry MUST NOT multiply
`exposureCount`.

`communication.js` already provides the primitive: a turn object created once per host turn by
`_ibTurnScope(label)`, threaded to model calls, XML tool batches, and continuation rounds as
`opts._ibTurn`; `_ibTurnLc(turn).end()` is documented **idempotent** (`communication.js:5538`
"幂等由 _ibTurnLc 保证（end 一次）").

**FROZEN: the idempotency key is session-local and derived from turn identity — and it MUST NOT
become a durable id.**

| candidate | verdict |
|---|---|
| **turn object identity** (a fresh object per `_ibTurnScope`) | ✅ **recommended for Browser** — no new id needed; a session-local `WeakSet` suffices |
| `turnId` string | ✅ usable on Home Node (`settled.turnId`); for group it already exists |
| `requestId` | ⚠ exists on Home Node; Browser chat does not use one consistently |
| `conversationId` | ❌ not turn-scoped; would collapse many turns into one |

No durable idempotency table may be introduced.

### 15.2 Decision table

| event | write exposure? | Browser | Home Node |
|---|---|---|---|
| request construction failed | **no** | A | error |
| network error before response | **no** | B | error |
| HTTP error status | **no** | C | error |
| model returned an error payload | **no** | E | error |
| stream started, then aborted by the user | **YES** | D reached ⇒ exposure already recorded | — |
| retry succeeds after earlier failures | **YES, once** | idempotent by turn identity | idempotent by `turnId` |
| retry exhausts all attempts | **no** | — | error |

**Known host-specific difference (declared, not hidden):** Browser records at *first token*
(so a user cancel after the first token still counts), while Home Node records at *turn settle with
`status !== 'error'`*. The two agree on the failure cases and differ only on "started then
cancelled". This is accepted for `R2-F1b`; unifying it would require changing the Browser provider
lifecycle beyond the current memory boundary (§16).

---

## 15.5 State lifetime and dependency injection (`P21-R2-F1b1`)

**Home Node — the instance MUST live on the service instance, not per request.**

Verified composition point: `services/home-node-service.js:297-302`

```js
memoryRetrieval: options.memoryRetrieval || createMemoryRetrieval({
  store: memoryStore, clock: options.clock, random: options.random, logger: serviceLog
})
```

`R2-F1b` MUST add the session state at that seam (or thread it through the same `options.*` override):

```js
sessionState: options.sessionState || createRecallSessionState()
```

Properties obtained: service-instance resident · survives across requests · resets on process
restart · injectable and clearable by tests (the existing `options.memoryRetrieval` override is the
precedent) · **not** a module-level singleton, so parallel suites cannot cross-contaminate.

> **MUST NOT** call `createRecallSessionState()` per request — cooldown would be permanently amnesiac.

**Browser** — one module-local instance per page load, exposed for tests. Reset on refresh is by design.

## 15.6 Turn identity (`P21-R2-F1b1` audit)

Verified call graph in `assets/js/communication.js`:

| site | scope |
|---|---|
| `:2975` `_ibTurnLc(_ibTurnScope('chat'))` | one turn per single-chat host turn; `begin()` `:2983`, `end()` `:3527` |
| `:2575` `_ibTurnLc(_ibTurnScope('group'))` | one turn **per speaking member** (code comment `:2573`) |
| `:4512` xml-continue | **reuses** the host turn when present (`if(!_turn)`), else creates its own |
| `:5603` model-call | creates only when no host turn exists (background) |

Retry / fallback reuse **the same turn object**:

- retry loops live **inside** `callApiChatStream` (`:5630`) and `callApiChat` (`:5707`), while `_ibTurn`
  is supplied by the caller;
- the streaming→non-streaming fallback (`:2746`) passes the **same** `_ibTurn:_mbTurn`;
- XML/tool continuation passes `_ibTurn:_turn` (`:4513`).

⇒ the turn object is a valid **session-local idempotency key**, and a `WeakMap<turnObject, turnIndex>`
needs no eviction.

## 15.7 Home Node idempotency (`P21-R2-F1b1` audit)

`mobile-gateway.js:1111`:

```js
const turnId = 'turn_' + CHAT_CORE.stableToken(parsed.requestId + ':' + parsed.conversationId);
```

- **content-addressed** ⇒ a retry of the same request yields the **same** `turnId`;
- duplicates short-circuit before execution (`:2367-2386` `chat-send-duplicate`; `:1137`
  `if (!existing) trackTurn(turn)`);
- `liveTurns` / `turnByRequest` are TTL-swept (`:589-595`, `TURN_TTL_MS`) ⇒ already bounded.

⇒ Home Node idempotency needs **only** `lastExposureTurn === turnIndex`. No per-memory `turnIds` set
and no extra bounded seen-`turnId` map beyond the existing `liveTurns` sweep.

## 16. Turn counter

Cooldown needs a monotonic, session-local `currentTurnIndex` per character.

MUST NOT use: `Date.now()` · message count · history length · any hydration-derived value
(`history` may be truncated or re-hydrated).

**FROZEN**

- `RecallSessionState` maintains its **own** per-character monotonic counter.
- The counter increments **once per real user model turn** (option B/D in the F1b0 audit), NOT per
  memory retrieval (A) and NOT per response completion (D-as-counter).
- **Counter increment and exposure write are two separate actions.**
- Increment MUST be idempotent with respect to retries (same turn identity ⇒ at most one increment).

---

## 17. State API (proposed, not frozen naming)

```js
createRecallSessionState()            // no IO, no clock, no persistence
state.beginTurn({ characterId, turnId })        // increments once, idempotent per turnId
state.getExposure({ characterId, memoryId })    // → { lastExposureTurn, exposureCount } | null
state.recordExposure({ characterId, memoryIds, turnId })  // idempotent per (turnId, memoryId)
state.clear()                          // test hook / explicit reset
```

Requirements (MUST):

- no IO · no DB · no `Date.now()` unless explicitly injected
- idempotent per turn
- resettable by tests
- character-scoped
- MUST NOT perform ACL, ranking, relevance, selection, or rendering

---

## 18. Cooldown pure function

```js
computeCooldown({ channel, currentTurn, lastExposureTurn, policy })
  → { factor, bypassed, reason }
```

MUST be **pure** and **deterministic**. MUST NOT read DB / global state / `Date.now()` /
durable `MemoryRecord` telemetry.

| situation | factor | bypassed | reason |
|---|---|---|---|
| no exposure record | `1` | `false` | `null` |
| channel bypass (`recall` / `glossary` / `coldStart`) | `1` | `true` | `cooldown-bypassed` |
| `surface`, `distance >= recoveryTurns` | `1` | `false` | `null` |
| `surface`, `0 < distance < recoveryTurns` | `< 1` | `false` | `cooldown-penalty` |

Reasons go **only** into the candidate `reasons[]` array. **No new result-level reason may be added.**

---

## 19. Trace contract

When `R2-F1b` lands:

- `cooldownFactor` MUST be the **real** factor applied. Never write `0.8` "to show the feature works".
- bypassed channel ⇒ `cooldownFactor = 1` + reason `cooldown-bypassed`
- penalised ⇒ `cooldownFactor < 1` + reason `cooldown-penalty`
- first exposure ⇒ `cooldownFactor = 1`, no reason
- **`CANDIDATE_KEYS` MUST NOT be extended.**
- **`finalScore` stays `null`** until the selector score becomes truthfully observable.

---

## 20. Reset semantics

| event | result |
|---|---|
| Browser page refresh | **RESET** (by design) |
| Home Node process restart | **RESET** (by design) |
| same character, different conversation | state **shared** (provided no restart happened) |

Resets are **not a bug** and MUST NOT be worked around by writing durable state.

Consequence to accept and state honestly: immediately after a restart, **no memory is in cooldown**.
The very first turn after a restart may therefore repeat a memory that was surfaced just before it.

---

## 21. Group semantics

Cooldown is scoped by **character identity**, never by group conversation.

Group forensics (verified, §5.1): in `_buildGroupChatContext(cfg, opts)`, `cfg` is the **speaking
role's** config while `group` is a separate object; the codebase itself records
`characterId: String((cfg && cfg.id) || '')`, and the group conversation id is derived separately
from `group.id`.

⇒ **Group has a reliable `characterId`; group cooldown is NOT required to fail closed.**

One implementation note (not a contract change): the group send path
(`communication.js:2732/2746/2757`) currently passes `_ibTurn` but **not** `_ibCharacterId`, whereas
the single-chat path (`:3178`, `:3338`) passes both. `R2-F1b` must supply the character id on the
group path too (it is available as `cfg.id`). If it cannot be supplied reliably, group cooldown
MUST **fail closed** rather than substitute a group id for a character id.

---

## 22. Presence limitation

`R2-E0-PARALLEL-RECALL-1` stands: Presence/proactive recall (`assets/js/active-diary.js`
`_activeRecentMemories`) is a second recall implementation that bypasses the canonical pipeline.
It will therefore have **no cooldown**.

> After `R2-F1b`, the correct claim is **"canonical chat recall has cooldown"**.
> **"system-wide cooldown" MUST NOT be claimed.**

This is an accepted, declared phase gap; it is not an `R2-F1b` blocker.

---

## 23. Explicitly forbidden in `R2-F1b`

- any durable exposure telemetry (`lastSurfacedAt` / `lastRecalledAt` / `lastSelectedAt` / `lastChannel` / `lastCooldownAt`)
- any schema / `DB_VER` / `MemoryRecord` change
- any new store, export/import, backup or migration entry
- implementing `reminisce`
- Presence convergence
- changing `activationPolicy` semantics
- re-penalising or removing candidates inside the Hard Gate
- using `lastActivated` as the cooldown clock

---

## 24. Semantic-delta plan for `R2-F1b`

Independent file: `tests/test_memory_recall_r2f_cooldown_delta.js`.
It MUST **not** extend the E matrix or the F1a matrix.

**EXPECTED CHANGED**

| id | case |
|---|---|
| C1 | immediate `surface` repeat ⇒ rank / selected changes |
| C2 | recent pinned `surface` ⇒ no longer dominates every turn |
| C3 | `recall` after recent exposure ⇒ bypassed, still selectable |
| C4 | `glossary` after recent exposure ⇒ bypassed |
| C5 | `recall`/`glossary` exposure ⇒ next `surface` is cooled |
| C6 | `coldStart` exposure ⇒ next `surface` is cooled |
| C7 | same character + different conversation ⇒ shared cooldown |

**EXPECTED SAME** — ACL · Hard Gate · glossary stable target · coldStart admission ·
coldStart `activationPolicy='none'` · full-remaining exploration · header budget ·
seat semantics · result shape · schema / `DB_VER=24` · legacy no-turn direct-core ·
`reminisce` still `FUTURE`.

---

## 25. Cross-references

- `docs/contracts/memory/MEMORY_RECALL_CONTRACT.md` — canonical recall contract (§9 exploration,
  §11 reason vocabulary). **Not modified by this document.**
- `R2-F1a-PIPELINE-DOC-1` — the recall contract's pipeline diagram lists `seat → exploration →
  budget`, while the implementation runs `budget(exploration) → seat cap`. Owned by **R2-G**.
  This cooldown contract is compatible with both (cooldown is inserted before ranking).
- `R2-E0-PARALLEL-RECALL-1` — Presence second recall (§22).
- `R2-E1b-ALIAS-BOUNDARY-1` — alias boundary debt; unrelated to cooldown.
