# Voice Architecture

**Status: Canonical**
**Scope: Current Voice Architecture**

> Current-state description of the InternalBeyond Voice system. Source-of-truth priority: production
> code → running tests → contracts → audit → phase documents → history. The `P23-*` documents are
> **provenance**, not authority; where they disagree with code, code wins.

---

## 1. Purpose

Voice gives characters a spoken surface without moving conversation ownership out of the chat runtime.
It covers two separate surfaces: **Voice Call** (real-time speech conversation) and **Voice Message**
(a recorded or synthesized audio clip attached to a chat message).

Voice is **not**: the conversation owner, the model executor, the memory owner, or the LLM provider
layer. It is an audio transport/format layer around the chat runtime.

---

## 2. Runtime Position

Voice has **two surfaces**; they must not be merged into one concept.

**Voice Call**

```
Mic → Voice Worklet → Bridge Voice Runtime → ASR
    → Browser Chat Runtime (MB + Memory + Model)
    → TTS → Playback
```

The bridge owns audio/ASR/TTS/session; the **browser chat runtime owns the model call, role context,
tools, history, and memory** (`bridge/voice-runtime.js` header).

**Voice Message**

```
Record → voice-message-core → Chat Message.voice → Playback
```

| Module | Layer | Responsibility |
| --- | --- | --- |
| `assets/js/communication/call.js` | Browser | capture, VAD/barge-in, WS client, playback queue |
| `assets/js/voice-worklet.js` | Browser | mic → 16k PCM16 + rms |
| `bridge/voice-runtime.js` | Bridge | call session state machine, ASR/TTS orchestration, generation guards |
| `bridge/asr.js` | Bridge | ASR transport (turn-based + opt-in streaming) |
| `bridge/tts.js` | Bridge | TTS provider registry + synthesis + Voice API Source map |
| `bridge/voicebox.js` | Bridge | external Voicebox local runtime adapter |
| `bridge/tts-voices.js` | Bridge | VoiceClone reference-audio file infrastructure |
| `assets/js/communication/voice.js` | Browser | voice message record/transcribe/playback |
| `assets/js/voice-message-core.js` | shared UMD | canonical voice-message contract |
| `assets/js/delivery-*.js` | shared UMD | multi-message turn delivery (not TTS) |

---

## 3. Voice Call Architecture

- Browser captures mic via `voice-worklet.js` and streams binary PCM frames over a WebSocket to the
  bridge `/voice` endpoint.
- Bridge `voice-runtime.js` drives the session state machine, runs ASR, and synthesizes TTS in ordered
  sentence units with generation guards.
- Protocol messages include `transcript_partial` / `transcript_final` (bridge→browser),
  `adapter_reply` / `adapter_reply_sentence` (browser→bridge), `audio` / `generation_end` /
  `interrupted` / `error` / `state` (bridge→browser).
- On a final transcript, the browser calls the normal chat entry (`sendChatMessage({ voiceCall:true,
  transcript, acousticReference, … })`) and streams the reply sentences back to the bridge for TTS.

---

## 4. Voice Message Architecture

A voice message is a canonical chat-message field (`voice`), not a Voice-runtime-owned store:

- Produced by `assets/js/communication/voice.js` (user recording) or by TTS for assistant messages.
- Shape defined by `assets/js/voice-message-core.js`; see
  [`../contracts/voice/VOICE_MESSAGE_CONTRACT.md`](../contracts/voice/VOICE_MESSAGE_CONTRACT.md).
- Persisted as part of the chat message; playback source is `dataUrl` or bridge `audioUrl`, never a
  runtime object URL.

---

## 5. ASR Boundary

ASR **owns**: audio capture transport, recognition, transcript generation.
ASR **does not own**: conversation state, memory, or model routing.

Two ASR shapes exist: turn-based `openai-whisper` (default) and an opt-in `streaming` provider
(`voiceAsr.streaming=true`); with no streaming provider wired, the runtime falls back to turn-based.
The provider is **config**, not architecture (`bridge/config.js voiceAsr`, `bridge/asr.js`).

---

## 6. TTS Boundary

Three distinct concepts, never merged:

| Layer | Owner |
| --- | --- |
| Character voice preference | Character configuration (`apiConfigs[].voice`) |
| TTS provider selection | Bridge (Voice API Source map) |
| Audio synthesis | TTS runtime (`bridge/tts.js` / `bridge/voicebox.js`) |
| Playback | Browser |

---

## 7. Character Voice Boundary

Character voice is a **preference**: it is stored on the character config and read at playback/synthesis
time (`assets/js/bridge.js` `_ibGetCharVoice`). It may carry `source/provider`, `voiceId`, `voiceType`,
`voiceData`, `voiceStyle`, and `autoPlay`. It never carries provider credentials, and it does not
constitute TTS runtime ownership.

---

## 8. Provider Boundary

Voice provider authority is **separate** from the LLM provider authority:

```
Voice:  bridge config (tts / ttsMimo / voicebox / voiceAsr) + bridge/tts.js / bridge/asr.js
LLM:    assets/js/provider-directory.js + assets/js/ib-model-core.js
```

The browser LLM provider layer contains no TTS/voice/speech handling. Voice does **not** use
`provider-directory`. The browser only sees a read-only source catalog (`/api/tts/sources`), never
credentials. Details: [`../contracts/voice/VOICE_PROVIDER_SOURCE_CONTRACT.md`](../contracts/voice/VOICE_PROVIDER_SOURCE_CONTRACT.md).

---

## 9. Audio Lifecycle

Classified by kind — never generalized:

| Kind | Persisted? | Where |
| --- | --- | --- |
| Call audio | **ephemeral** | streamed in memory; not persisted |
| Voice-message audio | **persisted** | chat message `voice.dataUrl` / `audioUrl` |
| VoiceClone reference audio | **persisted** | `DATA_DIR/tts-voices/<id>.<ext>` + `tts-voices.json` registry |
| Cached TTS mp3 (bridge) | transient cache | `DATA_DIR/tts` (`/tts/<name>`), name-pattern managed |

---

## 10. Session State

| State | Authority |
| --- | --- |
| recording | browser capture + bridge call session |
| transcribing | bridge ASR session |
| generating | browser chat runtime (model) |
| speaking | bridge TTS queue + browser playback |
| interrupted | bridge `call.state` |

Bridge `call.state` (`bridge/voice-runtime.js`) is the single source of truth for the call lifecycle
(`idle/connecting/listening/thinking/speaking/interrupting/error/ended`). The browser mirrors state for
UI; the mirror is not authority.

---

## 11. Barge-in

```
User speech (VAD) → browser stops playback → send {type:'interrupt'}
   → bridge interrupt(): state=interrupting, emit 'interrupted' + generation_end(interrupted:true),
     advance generation id, drop stale TTS/ASR chunks
   → resume listening
```

Recorded current behavior: barge-in stops playback and advances the generation guard; it does not
retroactively cancel delivered audio.

---

## 12. Memory Boundary

Voice does **not** own Memory lifecycle (see
[`MEMORY.md`](MEMORY.md) and [`../contracts/memory/`](../contracts/memory/)). Voice files do not call
memory APIs. A call transcript enters the **normal chat runtime**, where memory retrieval/consolidation
are handled by the memory subsystem.

---

## 13. Middle Brain Boundary

Per [MIDDLE_BRAIN.md](MIDDLE_BRAIN.md):

- a voice-call transcript enters the **normal chat pipeline** (`sendChatMessage`), so MB
  pre-generation (organize/compress) applies;
- the **voice surface bypasses the MB Character Integrity guard intentionally**
  (`middle-brain-integrity.js` `voice_surface` skip, tested).

Voice does **not** have a separate Middle Brain path.

---

## 14. Consumer Matrix

| Consumer | Relationship |
| --- | --- |
| Single/Group chat call | Voice Call around the chat runtime |
| Role DM | call/message using role voice preference |
| Voice Message | chat message `voice` field |
| Delivery (P23) | multi-message turn delivery; not TTS |
| Middle Brain | applies to the transcript via the chat pipeline (integrity bypassed for voice) |
| Memory | indirect, via chat runtime only |
| Mobile | no Voice authority in this document scope |

---

## 15. Configuration Boundary

| Config | Storage | Reader |
| --- | --- | --- |
| character `voice` preference | character config `apiConfigs[]` | browser bridge/social; bridge via `source` |
| TTS credentials/endpoints (`tts`, `ttsMimo`) | bridge `config.json` | `bridge/tts.js` |
| Voicebox endpoint | `config.voicebox.endpoint` → env → default | `bridge/voicebox.js` |
| ASR (`voiceAsr`) | bridge `config.json` | `bridge/asr.js` |

Credentials are masked in `/api/config` and never reach the browser.

---

## 16. UI Boundary

Voice UI is a **configuration/control surface**, not runtime authority: source catalog display,
character voice fields, VoiceClone upload, voice-message record button, and the call modal. Runtime
authority lives in the bridge/browser Voice modules.

---

## 17. Non-goals

Voice does not own: conversation state, model routing/execution, LLM provider selection, memory
lifecycle, Middle Brain composition, or provider credentials. It does not define the delivery/timing
policy of multi-message turns (that is the delivery contract) nor the acoustic reference algorithm
(that is the acoustic reference contract).

---

## 18. Enforcement

| Concern | Tests |
| --- | --- |
| Call runtime / session | `test_voice_runtime.js`, `test_voice_streaming.js`, `test_voice_reconnect.js` |
| Capture / playback | `test_voice_capture.js`, `test_voice_playback_path.js` |
| Providers | `test_mimo_tts.js`, `test_mimo_voiceclone.js`, `test_mimo_voicedesign.js`, `test_voicebox_provider.js`, `test_tts_voices.js` |
| Source/credential boundary | `test_voice_source.js` |
| Voice message | `test_native_voice_message.js`, `test_voice_message_lifecycle.js` |
| Acoustic reference | `test_call_acoustic_inject.js` |

Runtime behavior is enforced by these tests; this document is human canonical authority.

---

## 19. Historical References

Provenance only; not current authority:

- `docs/P23-1-VOICE-RUNTIME-FOUNDATION.md`, `docs/P23-2A-MESSAGE-SEQUENCE-CONTRACT.md`,
  `docs/P23-2B-DELIVERY-RUNTIME.md`, `docs/P23-2C-DELIVERY-PLANNER.md` (provisional phase docs)
- `docs/history/legacy/voice-runtime-phase1.md`, `docs/history/legacy/voice-runtime-phase2-3.md`
- `docs/P1-ACOUSTIC-REFERENCE.md`
