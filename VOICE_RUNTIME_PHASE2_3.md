# Voice Runtime Phase 2 + 3

> Note: `docs/` is currently claimed by another session (harness architecture
> diagrams), so this note lives at the repo root. The Phase 1 note is
> `docs/voice-runtime-phase1.md`.

This document describes the second and third stages of the InternalBeyond voice
runtime. Stage 1 (see `docs/voice-runtime-phase1.md`) remains intact: the voice
runtime is still a *transport / lifecycle layer* that never owns persona prompts,
model routing, tools, workspace access, chat history, summaries, or memory. All of
that lives in the browser chat runtime (`sendChatMessage`).

Phase 1 laid the foundation; Phase 2 makes the call *realtime*; Phase 3 makes voice
a first-class input/output modality of the existing role runtime.

```text
用户
  ↓ 麦克风
Browser VAD / AudioWorklet  (16kHz PCM16)
  ↓ WebSocket binary frames
Bridge Voice Runtime
  ├─ ASR Provider (streamable interface; turn-based Whisper-compatible default)
  │     speech_start ──(pcm)──> recognizer ──> transcript_partial … transcript_final
  │     (non-streaming fallback: speech_end ──> transcribe(wav) ──> transcript_final)
  ├─ transcript_final ────────> existing sendChatMessage (chatMessages + Memory + Tools)
  ├─ model token stream ──> sentence buffer ──> adapter_reply_sentence
  │   (non-streaming fallback: adapter_reply with the whole reply)
  ├─ TTS Queue ──> per-sentence synthesise ──> audio{seq, done}
  └─ generation guard ──> stale/late audio dropped on interrupt
  ↓ 扬声器
Audio Queue (ordered sentence playback, seq + done)
```

## Boundaries / non-goals (unchanged)

- No rewrite of the harness, ModelPort, chat runtime, memory, or tool runtime.
- Voice is a new *modality*; the model, tools, memory, workspace and history are
  the same ones used by text chat.
- No provider is forced to change to gain "streaming". Where a capability is not
  available, a stable fallback + a clear interface is used instead.

---

## Phase 2 — Realtime streaming

### 1. Streaming ASR (interface + fallback)

`bridge/asr.js` defines the provider interface. The default (out of the box)
provider, `openai-whisper`, is turn-based: it uploads one WAV turn to an
OpenAI-compatible `/audio/transcriptions` endpoint and returns one final text.
It never emits partials.

```js
const asr = createAsr(config);
asr.provider          // 'openai-whisper' by default
asr.configured        // voiceAsr{enabled,endpoint,apiKey,model} present
asr.streaming         // true only when voiceAsr.streaming===true && provider declares streaming
asr.transcribe(pcm)   // turn-based: resolves the final transcript
asr.createSession({onPartial,onFinal,onError})  // streaming session or null
```

A streaming session is shaped as `{ pushAudio(pcm), finalize(), cancel(), close() }`.
The runtime feeds every PCM chunk from the live capture to `pushAudio` as it
arrives (it no longer waits for the whole turn). The session emits `onPartial`
during capture and `finalize()` resolves the final transcript on `speech_end`.
When `asr.streaming` is false (or `createSession` returns null), the runtime uses
the turn-based `transcribe()` path. The protocol supports both cases:

```text
server -> client   speech_start      { generation_id }   (per-capture ASR generation)
                   transcript_partial { text, generation_id }
                   transcript_final   { text, turn_id, generation_id, final:true }  (+ legacy `transcript`)
```

`generation_id` here is the per-capture ASR generation (`call.asrGeneration`), a
distinct monotonic counter from the reply `generation`. Both bump on interrupt, so
a late ASR partial (or final) from an interrupted capture is dropped client-side.

A deployer wires a real streaming ASR provider via `createAsr.register(id, spec)`
and sets `voiceAsr.provider`/`voiceAsr.streaming`. Out of the box the project ships
only the turn-based Whisper-compatible provider; the streaming ASR interface and
chunk-forwarding plumbing are real but the active provider falls back to turn-based.

### 2. Streaming model → sentence buffer

The browser model runtime already streams (`callApiChatStream`). The voice call
reuses that chain — no second model runtime. A small, inert-only-when-voice sink
(`_makeVoiceSentenceSink` in `assets/js/communication.js`) is installed only for a
`voiceCall` turn. It receives the *cleaned* (post-thinking) stream text via the
existing `_sFlush` tap, strips XML markup (tool/calendar/memory/withdraw tags) so
they are never read aloud, splits on sentence boundaries, and forwards each
sentence to the server:

```text
LLM token stream ──> sink feeds sentences ──> adapter_reply_sentence { turn_id, text, done }
```

When streaming is off for the role, the whole reply is returned from
`sendChatMessage` and sent as a single `adapter_reply` (server still sentence-splits).

### 3. Streaming TTS queue (chunk pipeline)

The server (`bridge/voice-runtime.js`) keeps a per-session sentence queue. Both
`adapter_reply` (whole reply) and `adapter_reply_sentence` (incremental) enqueue
sentences for the same generation. `drainQueue` synthesises each sentence through
`tts.streamSynthesize` serially (so sentence order is preserved) and forwards every
audio chunk as soon as it is ready. Edge TTS produces a **true per-frame MP3
stream**; OpenAI / MiMo / clone / design providers return a whole clip and degrade
to a single-chunk-per-sentence stream (never faked as byte streaming).

```jsonc
server -> client  audio { generation_id, sentence_id, chunk_id, seq (=sentence_id), mime, data (base64), done }
```

- `sentence_id` + `chunk_id` + `generation_id` uniquely order and scope every chunk.
- `done:true` is the final chunk of the reply (the client may rely on it or on
  `generation_end`). We hold one chunk back so the correct `done` lands on the
  true final chunk (cost ~ one MP3 frame).
- `state` transitions to `speaking` on the first reply chunk and back to
  `listening` once the queue drains and the reply is marked done.

### browser audio pipeline

`assets/js/communication/call.js` plays chunks as a **MediaSource `audio/mpeg`**
stream (`_createMse`) so sentence 1 starts speaking the moment its first chunks
arrive, continuing as later chunks land, and flowing into sentence 2 without a
whole-clip wait. When the browser lacks `audio/mpeg` MSE support, it falls back to
assembling a sentence's chunks into one Blob and playing it whole (sentence-level
streaming). Every chunk is dropped on `generation_id` mismatch (barge-in/reconnect).

TTS queue operations exposed to the runtime:

```text
enqueue (submitReply)  ·  play/synthesise (drainQueue)  ·  cancel/clear (interrupt)
```

### 4. Real barge-in

Barge-in is the critical race: AI reply is being spoken / generated, the user
starts talking, the old reply must stop *and never resume*.

```text
speech_start (while speaking/thinking)
   ↓
interrupt('barge_in')
   ├─ browser: stopAudio()  (pause element, empty the client audio queue, revoke url)
   ├─ browser: stopStreaming() (abort the in-flight model call)
   ├─ server:  generation+1
   ├─ server:  cancel pendingTurn, clear TTS queue, null activeReply
   └─ drop every audio whose generation != current (queued or mid-synthesise)
```

Every audio event carries `generation_id`; the client and server both drop audio
whose captured generation no longer equals the current one — including the race
where a TTS HTTP request resolves *after* the interrupt (`item.generation !==
call.generation`).

### 5. Session state machine

State is the single source of truth; no boolean sprawl.

```text
idle ──> connecting ──> listening ──> thinking ──> speaking ──> listening
                                    │           │
                                    └────┬──────┘
                                         ↓
                                    interrupting ──> listening
any state ──> error / ended
```

`bridge/voice-runtime.js` enforces the allowed transitions from `STATES`, sets
`call.state`, and broadcasts a `state` event. `interrupt()` is the only place that
moves into `interrupting`.

---

## Phase 3 — Deep role-runtime integration

Voice is an input/output modality of the *same* role runtime.

### Voice profile
The call carries `start{ ..., voice: role.voice }`, which is normalised by the
existing `tts.normalizeVoiceProfile` (provider/model/voiceId/rate/pitch/language/
style; clone/design handled by capabilities). No separate voice-config shape.

### Memory
Voice transcript and reply go through `sendChatMessage`, so they are persisted as
normal `chatMessages` and participate in the same summary / Auto-Memory pipeline.
No second voice memory. The user message keeps the voice metadata:

```jsonc
{ "source": "voice_call", "callSessionId": "...", "turnId": "..." }
```

### Tools / workspace
The voice turn runs the full model runtime, so tools and workspace access work
unchanged (e.g. "帮我看一下…" → tool → result → voice reply).

### Conversation continuity
A call uses `conversationId = main:<roleId>` (or `thread:<id>`). The transcript +
reply are written into the same history that text chat reads, so text and voice are
interchangeable across the session; a later text message remembers the call, and a
later call remembers the text.

### UI
`startVoiceCall()` opens the full panel: avatar, live state, transcript + reply,
meter, and controls — interrupt, mute (mic), speaker (output), hangup. Works on
desktop and mobile (CSS media query in `assets/css/voice-call.css`).

---

## WebSocket voice event protocol

Client → server: `start`, binary PCM16, `speech_start`, `speech_end`, `text`,
`adapter_reply` (whole reply), `adapter_reply_sentence` (incremental), `interrupt`,
`hangup`.

Server → client: `call_started`, `state`, `speech_start`, `speech_end`,
`transcript_partial`, `transcript_final` (+ legacy `transcript`), `reply_text`,
`audio` (seq/done/generation), `generation_end`, `interrupted`, `hangup`, `error`,
`nothing_heard`.

---

## Fallback matrix

| Capability | Streaming path | Fallback | Why |
|---|---|---|---|
| ASR | live session (per-PCM-chunk feed, partial/final) | turn-based `transcribe()` | no streaming endpoint wired in this project |
| Model | `callApiChatStream` → sentence sink | full reply `adapter_reply` | non-streaming roles |
| TTS | Edge per-frame MP3 stream → `audio{sentence_id, chunk_id}` | sentence-level single chunk | OpenAI/MiMo return whole clips; never faked as byte stream |
| Browser audio | MediaSource `audio/mpeg` chunk playback | whole-sentence Blob | browsers without MP3 MSE |
| Barge-in | generation + per-capture ASR generation guard | — | guards alone are sufficient |

## Real provider smoke

- Edge TTS streaming is **code-tested** (chunk ordering / done / barge-in drop),
  but the live `speech.platform.bing.com` handshake was unreachable in the build
  sandbox (outbound network blocked: `REAL EDGE STREAM ERROR: handshake failed`),
  so it is **not network-verified here** and requires a normal networked host.
- No real ASR/model/mic E2E was possible (no provider credentials / no mic in the
  sandbox). The full mic→ASR→model→TTS→speaker loop is not exercised end-to-end.

## Tests

- `test_voice_streaming.js` — sentence queue, streaming ASR partial/final,
  interrupter race, barge-in clears queue, streaming TTS chunk ordering
  (sentence_id/chunk_id/done), barge-in drops late TTS chunks, ASR generation race
  (old partial dropped), reconnect (fresh CallSession), ASR provider capability gate,
  empty-done completion.
- `test_voice_runtime.js` — Phase 1 contract preserved.
- Registered in `test-all.js` service group.
