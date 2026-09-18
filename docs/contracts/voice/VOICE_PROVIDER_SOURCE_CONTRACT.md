# Voice Provider Source Contract

**Status: Canonical**
**Scope: Voice API Source ↔ provider mapping and the credential boundary**

> Current-state contract for how a character's voice preference selects a TTS provider without ever
> holding provider credentials. Source: `bridge/tts.js` (`TTS_PROVIDER_REGISTRY`,
> `TTS_SOURCE_TO_PROVIDER`, `listVoiceSources`) and `tests/test_voice_source.js`.

---

## 1. Two Vocabularies

- **Voice API Source** — the canonical reference a **character** stores: `edge` / `tts` / `ttsMimo` /
  `voicebox`.
- **provider** — the wire-level id used internally by the bridge.

A character stores only the **source**; the `source → provider` mapping exists in exactly one place
(`bridge/tts.js` `TTS_SOURCE_TO_PROVIDER`). Historical data without `source` keeps the legacy
`provider` default rule.

---

## 2. Provider Registry

| Source | provider | Credential source |
| --- | --- | --- |
| `edge` | Edge TTS | `none` (no credential) |
| `tts` | OpenAI-compatible TTS | `bridge:tts` |
| `ttsMimo` | MiMo TTS | `bridge:ttsMimo` |
| `voicebox` | Voicebox local runtime | `local-runtime` |

---

## 3. Credential Boundary (hard)

- Credentials live only in bridge `config.json` (`tts`, `ttsMimo`, `voicebox`, `voiceAsr`).
- The browser receives a **read-only source catalog** (`GET /api/tts/sources`): id, label, capability
  description, and a `credential` **description** (e.g. `none`, `bridge:tts`, `local-runtime`) — never a
  credential value.
- `/api/config` masks `tts.apiKey` / `ttsMimo.apiKey` / `voiceAsr.apiKey`.
- A character can therefore be shared/exported without leaking provider credentials.

---

## 4. Normalization

`normalizeVoiceProfileCore(raw, cfg)` accepts three legacy shapes (flat character voice object,
canonical Voice Profile, flat REST/WS params) and emits one internal form:
`{ provider, model, voice:{type,id,data}, language, style, rate, pitch, text }`. Unknown `voiceType` or
unsupported capability falls back to `builtin`; unsupported fields are dropped (never sent upstream).

---

## 5. VoiceBox Boundary

Voicebox is an **external local runtime** (separate process). IB does not copy, embed, install, or
start it; it only calls its REST API. The default endpoint appears once
(`bridge/voicebox.js DEFAULT_ENDPOINT`), resolved as `config.voicebox.endpoint` → env → default.
IB is the "what to say" authority; Voicebox is the "how to say it" runtime
(`personality:false`; no rewrite channel).

---

## 6. ASR Provider

ASR providers are config, not wire sources: bridge `config.voiceAsr` drives `bridge/asr.js`
(turn-based `openai-whisper`, opt-in streaming). ASR is not part of the character voice source catalog.

---

## 7. Non-goals

This contract does not define the voice-message shape, delivery/timing, or the UI.

---

## 8. Enforcement

| Test | Pins |
| --- | --- |
| `tests/test_voice_source.js` | source↔provider mapping, credential boundary, catalog shape |
| `tests/test_voicebox_provider.js` | Voicebox adapter contract |
| `tests/test_mimo_tts.js` / `_voiceclone` / `_voicedesign` | MiMo provider behavior |

---

## 9. Historical Origin

`bridge/tts.js` (P23 Phase 1). Phase provenance: `docs/P23-1-VOICE-RUNTIME-FOUNDATION.md`.
