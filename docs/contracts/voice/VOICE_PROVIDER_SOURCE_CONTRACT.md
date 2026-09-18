# Voice Provider Source Contract

**Status: Canonical**
**Scope: Voice API Source ↔ provider 映射与 credential 边界**

> 关于 character 的 voice preference 如何选择 TTS provider 而绝不持有 provider credentials 的
> 当前状态 Contract。Source：`bridge/tts.js`（`TTS_PROVIDER_REGISTRY`、
> `TTS_SOURCE_TO_PROVIDER`、`listVoiceSources`）与 `tests/test_voice_source.js`。

---

## 1. 两套词表

- **Voice API Source** —— **character** 存储的 canonical reference：`edge` / `tts` / `ttsMimo` /
  `voicebox`。
- **provider** —— bridge 内部使用的 wire-level id。

character 只存储 **source**；`source → provider` 映射只存在于一个地方
（`bridge/tts.js` `TTS_SOURCE_TO_PROVIDER`）。没有 `source` 的历史数据保留 legacy
`provider` default 规则。

---

## 2. Provider Registry

| Source | provider | Credential source |
| --- | --- | --- |
| `edge` | Edge TTS | `none` (no credential) |
| `tts` | OpenAI-compatible TTS | `bridge:tts` |
| `ttsMimo` | MiMo TTS | `bridge:ttsMimo` |
| `voicebox` | Voicebox local runtime | `local-runtime` |

---

## 3. Credential Boundary（硬性）

- Credentials 只存在于 bridge `config.json`（`tts`、`ttsMimo`、`voicebox`、`voiceAsr`）。
- browser 只接收一个**只读 source catalog**（`GET /api/tts/sources`）：id、label、capability
  描述，以及 `credential` **描述**（例如 `none`、`bridge:tts`、`local-runtime`）—— 绝不是
  credential 值。
- `/api/config` 会遮蔽 `tts.apiKey` / `ttsMimo.apiKey` / `voiceAsr.apiKey`。
- 因此 character 可以被共享/导出，而不会泄漏 provider credentials。

---

## 4. Normalization

`normalizeVoiceProfileCore(raw, cfg)` 接受三种 legacy shape（扁平 character voice 对象、
canonical Voice Profile、扁平 REST/WS params），并产出一种内部形式：
`{ provider, model, voice:{type,id,data}, language, style, rate, pitch, text }`。未知 `voiceType` 或
不支持的 capability 会回退到 `builtin`；不支持的字段会被丢弃（绝不发往 upstream）。

---

## 5. VoiceBox 边界

Voicebox 是一个**外部 local runtime**（独立进程）。IB 不会复制、内嵌、安装或启动它；
它只调用其 REST API。default endpoint 只出现一次
（`bridge/voicebox.js DEFAULT_ENDPOINT`），按 `config.voicebox.endpoint` → env → default 解析。
IB 是 "what to say" authority；Voicebox 是 "how to say it" runtime
（`personality:false`；无 rewrite channel）。

---

## 6. ASR Provider

ASR providers 是 config，不是 wire sources：bridge `config.voiceAsr` 驱动 `bridge/asr.js`
（turn-based `openai-whisper`，opt-in streaming）。ASR 不属于 character voice source catalog。

---

## 7. Non-goals

本 Contract 不定义 voice-message shape、delivery/timing 或 UI。

---

## 8. Enforcement

| 测试 | Pins |
| --- | --- |
| `tests/test_voice_source.js` | source↔provider 映射、credential 边界、catalog shape |
| `tests/test_voicebox_provider.js` | Voicebox adapter Contract |
| `tests/test_mimo_tts.js` / `_voiceclone` / `_voicedesign` | MiMo provider 行为 |

---

## 9. 历史引用

`bridge/tts.js`（P23 Phase 1）。Phase provenance：`docs/P23-1-VOICE-RUNTIME-FOUNDATION.md`。
