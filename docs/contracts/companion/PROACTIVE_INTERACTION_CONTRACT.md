# Companion Proactive Interaction Contract

**Status: Canonical**
**Scope: Proactive interaction vocabulary, event shape, call states, dedup, DND**

> Current-state contract for proactive interactions. Source of truth:
> `assets/js/proactive-interaction-core.js` (shared UMD, browser + Node), `active/plan-domain.js`,
> `active/scheduler.js`, and `tests/test_proactive_interaction.js` / `test_proactive_phase2.js`.
> Frequency/retry mechanism lives in `AUTONOMY.md`; this contract fixes the vocabulary and invariants.

---

## 1. Interaction Types

```
INTERACTIONS = ['text_message', 'voice_call']
```

`normalizeInteraction(value)` returns the value only if it is in the whitelist, otherwise
`text_message`. **Voice is not the default.**

---

## 2. Event Shape

`normalizeEvent(raw)` produces:

```
{
  eventId, roleId, roleName, avatar,
  interaction,            // text_message | voice_call
  reason, openingMessage, openingLine,
  createdAt,
  callMeta: { conversationId, openingLine },
  status,                 // pending | accepted | declined | dismissed
  actedAt, planId
}
```

- `status` advances only through UI actions (`pending → accepted / declined / dismissed`).
- Call metadata carries a conversation id and opening line.

---

## 3. Call States

`CALL_STATES = ['idle','incoming','connecting','connected','listening','thinking','speaking',
'interrupting','ending','ended']` with an allowed-transition table (`canTransition`).

These are the **front-end proxy states** for the inbound/answer/hang-up phases. Once a real voice
session starts, the **Voice runtime session state is the single source of truth** (see `VOICE.md` and
`assets/js/communication/call.js`). `canTransition` constrains only front-end transitions; it does not
override runtime authority.

---

## 4. Dedup

- `eventKey` = `roleId | interaction | normalized-opening-text`.
- `isDuplicateEvent(ev, recent)` treats as duplicate: an existing **pending** same-role/same-interaction
  event, or opening text with bigram-Dice similarity ≥ `0.82`.
- `textSimilarity` is the shared bigram-Dice measure; `purgeExpired` keeps non-pending events and expires
  stale pending events (default 2h).

---

## 5. DND / Send / Reschedule / Cancel

`active/plan-domain.js` owns policy:

- `isInDnd(now, prefs)` / `nextDndFree(now, prefs)` implement the do-not-disturb window;
- a plan respects `cancelConditions.respectDoNotDisturb`, `cancelIfUserReplies`,
  `cancelIfNewerPlanExists`;
- a plan evaluation returns one of **send / reschedule / cancel** with a reason;
- the plan lifecycle is `scheduled → evaluating → sending → waiting_for_user`, with
  `failed` (max attempts), `cancelled`, `expired` (late > 30 min) terminal states.

(Full state machine and thresholds: `AUTONOMY.md`.)

---

## 6. Boundary

> AI can proactively send a message **≠** Companion owns the message lifecycle.

Companion plans/executes and queues; the **Chat Runtime** owns persistence and delivery. Voice is
delegated to the Voice system, not re-implemented here.

---

## 7. Non-goals

This contract does not define chat storage/delivery, Voice internals, Moments/Diary/Letter behavior, or
relationship state.

---

## 8. Enforcement

| Test | Pins |
| --- | --- |
| `tests/test_proactive_interaction.js` | interaction/event/state vocabulary, dedup |
| `tests/test_proactive_phase2.js` | phase-2 behavior invariants |
| `tests/test_proactive_trace.js` | observability only (no decisions) |
| `tests/test_active_plans.js` | plan DND/send/reschedule/cancel |

---

## 9. Historical Origin

`assets/js/proactive-interaction-core.js`; mechanism context in `docs/AUTONOMY.md`.
