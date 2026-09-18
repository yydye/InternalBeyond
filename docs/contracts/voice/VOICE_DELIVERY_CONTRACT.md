# Voice Delivery Contract

**Status: Canonical**
**Scope: Multi-message turn delivery (sequence, planning, timing, cancel)**

> Current-state contract for turning one assistant turn into N canonical chat messages and delivering
> them over time. Sources: `assets/js/delivery-sequence-core.js` (Phase 2A),
> `assets/js/delivery-planner.js` (Phase 2C), `assets/js/delivery-runtime.js` (Phase 2B), and
> `tests/test_message_sequence_contract.js`, `tests/test_delivery_runtime.js`.
> This is a **chat-message delivery** contract, not a TTS contract.

---

## 1. Model

One model turn may produce **N independent canonical chat messages** (a "unit" = one canonical
`chatMessage`). The delivery contract answers only *which units, in what order, at what time, in what
state*.

---

## 2. Sequence Shape (Phase 2A)

```
{
  mode: 'single' | 'sequence',
  units: [ { kind: 'text', content: '…' }, … ],
  segments: [ … ],
  policy: { … },
  stats: { … }
}
```

- `validate(sequence)` enforces the shape.
- `buildMessages(sequence)` deterministically produces canonical `chatMessages[]`.
- `orderMessages()` / `compareMessages()` give a deterministic order.
- The core contains **no** runtime, DOM, timers, provider, or TTS knowledge.

---

## 3. Planner (Phase 2C)

The Delivery Planner maps a single generated assistant turn to a delivery sequence. Its **only**
responsibility is content structure — it does not decide time, persist, render, call a model, or call
TTS, and it uses no randomness or wall clock.

---

## 4. Runtime (Phase 2B)

The Delivery Runtime is the single authority for delivering an already-built sequence over time:

- unit states: `queued → delivering → completed | cancelled | failed`;
- per-unit timing is deterministic given injected time (`now` / `setTimeout` / `clearTimeout`);
- typing is surfaced through an injected `onTyping` callback (the module does not touch the DOM);
- `cancel` (user interrupt / stop) cancels only **not-yet-delivered** units — already-delivered units
  are preserved;
- a new generation supersedes an in-flight one under the same "new utterance" semantics as a user
  interrupt.

---

## 5. Boundary

| Component | Owns | Does Not Own |
| --- | --- | --- |
| `delivery-sequence-core.js` | sequence validation, deterministic message build/order | timing, storage, TTS |
| `delivery-planner.js` | content structure (turn → sequence) | timing, persistence, rendering, model |
| `delivery-runtime.js` | delivery timing/order/state/cancel | content selection, TTS, DOM |

Delivery does not select voice vs text vs image (that is planner/upper-layer content), and does not
synthesize audio.

---

## 6. Non-goals

Group runtime, proactive-message policy changes, emotion planner, personality rewrite, large-scale chat
schema migration, Voicebox streaming, and image generation planning are outside this contract.

---

## 7. Enforcement

| Test | Pins |
| --- | --- |
| `tests/test_message_sequence_contract.js` | sequence shape / build / order |
| `tests/test_delivery_planner.js` | turn → sequence content planning |
| `tests/test_delivery_runtime.js` | timing, state machine, cancel semantics |

---

## 8. Historical Origin

Phase provenance: `docs/P23-2A-MESSAGE-SEQUENCE-CONTRACT.md`,
`docs/P23-2B-DELIVERY-RUNTIME.md`, `docs/P23-2C-DELIVERY-PLANNER.md`.
