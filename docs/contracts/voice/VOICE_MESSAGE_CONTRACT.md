# Voice Message Contract

**Status: Canonical**
**Scope: The canonical chat-message `voice` field**

> Current-state contract for a voice message. Derived from `assets/js/voice-message-core.js` (UMD,
> shared by browser and Node). It defines the object shape only — no I/O, storage, transport, or
> provider judgment.

---

## 1. Field

`voice` is a canonical chat-message field (`chat-core.js` `CONDITIONAL_FIELDS`; `validateMessage`
requires it to be an object). This contract defines the object's shape.

---

## 2. Shape

User recording (must be preserved verbatim):

```
{ dataUrl, mime, duration, transcript, tone }
```

Assistant (AI) voice message:

```
{
  dataUrl,        // inline audio; '' if absent
  audioUrl,       // bridge local reference (/tts/<id>.<ext>); '' if absent
  mime, duration, transcript,
  contentHash,    // optional: fingerprint of the content this audio was generated from
  provenance: { source, provider, engine, model, voiceId, voiceType, refAudioId, profile }
}
```

- `dataUrl` and `audioUrl` — **at least one is required** for a message's voice to be valid; an inline
  audio larger than `INLINE_MAX_BYTES` (2,000,000 bytes) degrades to the bridge reference, or the voice
  is dropped entirely (never a "playable" voice with no source).
- `mime` defaults from URL/extension (`audio/mpeg` fallback); `duration` is a positive number or 0.

---

## 3. Provenance (hard security boundary)

`provenance` is a **flat, whitelisted, scalar** set:
`source, provider, engine, model, voiceId, voiceType, refAudioId, profile`.

- Unknown keys, nested objects, and empty values are dropped.
- Any secret-shaped key (`apikey|api_key|secret|token|authorization|password|credential|bearer`,
  case-insensitive) and any bearer/`sk-` value is rejected — at any nesting level.
- `bridge/tts.js` credentials and endpoints never enter the message.

---

## 4. Freshness / Lifecycle

- `contentHash` records the content the audio was generated from (`contentFingerprint`).
- `isStale(msg)` is true when `voice.contentHash` no longer matches `contentFingerprint(msg.content)`;
  records without `contentHash` fail open (renderable).
- **Any path that rewrites assistant content must call `dropVoice(msg)`** (immutable semantics: delete
  the voice rather than letting text and audio diverge). `isAiVoiceMessage(msg)` requires a non-stale,
  playable voice on a non-user message.

---

## 5. Playback Source

`playSrc(voice)` is the only resolver: inline `dataUrl` first, then bridge `audioUrl`, else `''`.
It never returns an object URL — the source must survive reload.

---

## 6. Persistence Boundary

The voice object is persisted **as part of the chat message**. It is not a separate store and not owned
by the Voice runtime.

---

## 7. Non-goals

This contract does not define chat message routing, delivery/timing, provider selection, or the
acoustic reference algorithm.

---

## 8. Enforcement

| Test | Pins |
| --- | --- |
| `tests/test_native_voice_message.js` | canonical shape, provenance whitelist, secret rejection, build/playSrc |
| `tests/test_voice_message_lifecycle.js` | lifecycle (stale/drop voice, closure fixes) |
| `tests/test_voice_playback_path.js` | playback source path |

---

## 9. Historical Origin

`assets/js/voice-message-core.js` (P23 Phase 1). Phase provenance:
`docs/P23-1-VOICE-RUNTIME-FOUNDATION.md`.
