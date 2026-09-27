# Voice Provider Source Contract

**Status: Canonical**
**Scope: Voice API Source ↔ provider 映射与 credential 边界**

> 关于 character 的 voice preference 如何选择 TTS provider 而绝不持有 provider credentials 的
> 当前状态 Contract。Source：`bridge/tts.js`（`TTS_PROVIDER_REGISTRY`、
> `TTS_SOURCE_TO_PROVIDER`、`listVoiceSources`）与 `tests/test_voice_source.js`。
>
> 当前完整 Voice Runtime 架构见 [`../../architecture/VOICE.md`](../../architecture/VOICE.md)。本文只
> 冻结 TTS Voice API Source 与 ASR provider 的 provider/credential 交界，不替代总架构文档。

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

- Bridge-side credentials 存在于 Bridge `config.json`（`tts`、`ttsMimo`、`voiceAsr`）；Voicebox
  local runtime 不使用 Voicebox API key。
- browser 只接收一个**只读 source catalog**（`GET /api/tts/sources`）：id、label、capability
  描述，以及 `credential` **描述**（例如 `none`、`bridge:tts`、`local-runtime`）—— 绝不是
  credential 值。
- `/api/config` 会遮蔽 `tts.apiKey` / `ttsMimo.apiKey` / `voiceAsr.apiKey`。Voicebox ASR 只接受
  localhost runtime，并由 Bridge 代理音频；ASR capabilities/upload response 不返回 Voicebox endpoint。
- **Separate legacy path**：语音消息旧 `apiSettings.voiceTrans` 仍把用户配置的外部
  OpenAI-compatible endpoint/key/model 保存在 Browser IndexedDB，并由 Browser 直接请求。它不是
  Voice API Source、不是 Voicebox ASR 路径，也不改变本 Contract 的 Bridge provider credential authority。
  当前文档记录这一差异；P34 Credential Authority 与该旧路径的实现均不在本 Contract 修改范围内。
- 因此 role `apiConfigs[].voice` 可以被共享/导出而不会泄漏 TTS provider credentials。

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
Voicebox 的 cloned profile、参考样本与声学资产仍由 Voicebox 保存；IB role 只保存 `source:'voicebox'`
和外部 `voiceId/profileId`，缺失时需显式 rebind，不按名称匹配。

---

## 6. ASR Provider

ASR providers 是 Bridge config，不是 wire sources：`config.voiceAsr.provider` 驱动
`bridge/asr.js`。当前内置 `openai-whisper` 与 `voicebox` 都是 turn-based；Voicebox 也可经
Bridge 接收完整音频文件。Voicebox capabilities 固定为：

```js
{ streaming: false, partialResults: false, cancellation: false, timestamps: false }
```

Bridge 在 Voicebox `/transcribe` 前只读检查 `/models/status`；所选模型未缓存或状态不可用时拒绝，
不触发下载。`GET /api/asr/capabilities` 只返回 provider/capability metadata；
`POST /api/asr/transcriptions` 接受经过 content type、音频签名与大小验证的音频 bytes，不接受
filesystem path，并由 Bridge 代理给 localhost Voicebox。Voicebox 没有 physical inference cancellation；
Voice Call interrupt 只依靠 turn/request identity 与 stale-result discard。ASR 不属于 character
voice source catalog，也不拥有 persona、conversation 或 response generation。

---

## 7. Non-goals

本 Contract 不定义 voice-message shape、delivery/timing 或 UI。

---

## 8. Enforcement

| 测试 | Pins |
| --- | --- |
| `tests/test_voice_source.js` | source↔provider 映射、credential 边界、catalog shape |
| `tests/test_voicebox_provider.js` | Voicebox adapter Contract |
| `tests/test_voicebox_asr_provider.js` | Voicebox ASR capabilities、model preflight、音频边界、logical stale-result guard |
| `tests/test_mimo_tts.js` / `_voiceclone` / `_voicedesign` | MiMo provider 行为 |

---

## 9. 历史引用

`bridge/tts.js`（P23 Phase 1）。Phase provenance：`docs/P23-1-VOICE-RUNTIME-FOUNDATION.md`。
