# Voice Runtime Phase 1

## Boundary

The voice runtime is a transport and lifecycle layer. It does not own persona prompts, model routing, tools, workspace access, chat history, summaries, or memory.

```text
Microphone -> browser VAD -> Bridge WebSocket -> ASR
  -> transcript -> existing sendChatMessage runtime
  -> persisted user/assistant messages + existing Memory/Tools
  -> adapter_reply -> existing Bridge TTS -> generation-scoped audio
```

The implementation was designed after auditing PaiVoice commit `055c6cc40fe8bfff638f4a17c635878d3da16955`. The Call Event Protocol, client-side VAD approach, and monotonically increasing generation guard were used as architectural references. No PaiVoice source was copied because PaiVoice is AGPL-3.0 and InternalBeyond uses a different code license.

## Voice Session

Each WebSocket connection owns at most one session:

```text
callSessionId
roleId
conversationId
generation
state: listening | thinking | speaking | interrupted | ended
```

The browser starts it with:

```json
{
  "type": "start",
  "roleId": "character-id",
  "conversationId": "main:character-id"
}
```

Topic conversations use `thread:<thread-id>` as `conversationId`.

## Events

Client to server: `start`, binary PCM16 chunks, `speech_start`, `speech_end`, `adapter_reply`, `interrupt`, and `hangup`.

Server to client: `speech_start`, `speech_end`, `transcript`, `reply_text`, `audio`, `interrupted`, `generation_end`, `hangup`, `state`, and `error`.

`adapter_reply` is the InternalBeyond Voice Adapter boundary. The browser obtains its text by awaiting the existing `sendChatMessage` function. That path persists the transcript as a normal user message, builds the existing role and memory context, runs the configured model and tools, executes memory operations, and persists the assistant message before returning the final reply text.

## Interrupt

An interrupt performs all of the following:

1. The browser immediately pauses and releases the active audio element.
2. The browser invokes the existing chat stream stop function when model generation is still running.
3. The server increments the session generation and cancels the pending turn.
4. A late TTS result is discarded unless its captured generation still equals the current session generation.
5. The client ignores every audio event whose `generation_id` is not current.

This makes stale audio unable to resume after a barge-in, including the race where the TTS HTTP request finishes after the interrupt.

## ASR Configuration

ASR credentials live only in the Bridge data directory's `config.json`:

```json
{
  "voiceAsr": {
    "enabled": true,
    "endpoint": "https://api.openai.com/v1/audio/transcriptions",
    "apiKey": "YOUR_SERVER_SIDE_KEY",
    "model": "whisper-1",
    "language": "zh",
    "timeoutMs": 60000,
    "maxTurnSeconds": 60
  }
}
```

The endpoint must accept the OpenAI-compatible multipart transcription shape. `/api/config` masks this key. No provider credential is sent through the call WebSocket or stored in browser state.

## Phase 1 Limits

- VAD is energy-based and runs in the browser; it is not a neural VAD.
- ASR runs after `speech_end`, so transcription is turn-based rather than streaming.
- The existing model runtime finishes a text reply before TTS starts.
- TTS produces one complete MP3 before playback; sentence-level audio streaming is not implemented.
- WebSocket transports PCM and base64 MP3; WebRTC and OpenAI Realtime are intentionally out of scope.
- Echo cancellation depends on browser and operating-system audio processing.
