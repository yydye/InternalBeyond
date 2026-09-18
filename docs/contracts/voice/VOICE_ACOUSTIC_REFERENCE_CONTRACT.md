# Voice Acoustic Reference Contract

**Status: Canonical**
**Scope: Acoustic mood reference injection for voice calls**

> Current-state contract for the request-local acoustic mood reference captured during a voice-call
> turn and injected into the LLM request. Sources: `assets/js/communication/call.js`
> (`_acousticReferenceFor`), `assets/js/communication/voice.js` (`_vmToneAnalyze`),
> `docs/P1-ACOUSTIC-REFERENCE.md`, and `tests/test_call_acoustic_inject.js`.

---

## 1. What It Is

A short textual "acoustic mood reference" derived from the **current turn's** accumulated PCM +
transcript, attached to the request so the model can be aware of the caller's tone. It is request-local
and describes the *present* turn only.

---

## 2. Scope (hard)

- Injected **only into the LLM request**.
- It is **not** an ASR contract and **not** a TTS contract.
- It does not modify or bypass the ASR/TTS boundary; it is carried alongside the transcript.
- It never persists audio: the reference is computed from the current turn's in-memory chunks and is
  released after the turn.

---

## 3. Conditions

`_acousticReferenceFor(roleCfg, chunks, transcript)` returns `''` (no reference) when:

- the tone helpers are unavailable;
- there are no chunks / zero bytes;
- the derived tone is empty;
- the role is **audio-native** (`_vmAudioNative(roleCfg)` true, or `roleCfg.audioInput === true`) — in
  that case the model receives the audio directly and no text reference is injected.

Otherwise it returns the tone string.

---

## 4. Single Implementation

`_vmToneAnalyze` is the **single** algorithm implementation; `docs/P1-ACOUSTIC-REFERENCE.md` records
that the fork's upstream had it, and this fork keeps exactly one implementation. No duplicate analyzer.

---

## 5. Consumer

The voice call is the only consumer: `call.js` calls the helper at `onTranscript` and passes the result
as `acousticReference` into `sendChatMessage`.

---

## 6. Non-goals

This contract does not define the tone algorithm itself, does not persist analysis, and does not apply
to voice messages.

---

## 7. Enforcement

| Test | Pins |
| --- | --- |
| `tests/test_call_acoustic_inject.js` | injection conditions / non-injection cases (P1 stage 2) |
| `tests/test_voice_pcm_adapter.js` | PCM → audio-like adapter used by the reference |

---

## 8. Historical Origin

`docs/P1-ACOUSTIC-REFERENCE.md`; `assets/js/communication/call.js`.
