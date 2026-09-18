# Voice 架构

**Status: Canonical**
**Scope: 当前 Voice 架构**

> InternalBeyond Voice 系统的当前状态描述。真相来源优先级：production
> code → running tests → contracts → audit → phase documents → history。`P23-*` 文档属于
> **provenance**，而非 authority；当它们与代码不一致时，以代码为准。

---

## 1. 目的

Voice 为 character 提供口头表达的 surface，同时不将 conversation ownership 移出 chat runtime。
它覆盖两个彼此独立的 surface：**Voice Call**（实时语音对话）与 **Voice Message**
（附加到 chat message 上的录制或合成音频片段）。

Voice **不是**：conversation 的 owner、model executor、memory owner 或 LLM provider
layer。它是围绕 chat runtime 的 audio transport/format layer。

---

## 2. Runtime 位置

Voice 有**两个 surface**；它们绝不能被合并为一个概念。

**Voice Call**

```
Mic → Voice Worklet → Bridge Voice Runtime → ASR
    → Browser Chat Runtime (MB + Memory + Model)
    → TTS → Playback
```

bridge 拥有 audio/ASR/TTS/session；**browser chat runtime 拥有 model call、role context、
tools、history 与 memory**（`bridge/voice-runtime.js` header）。

**Voice Message**

```
Record → voice-message-core → Chat Message.voice → Playback
```

| 模块 | 层级 | 职责 |
| --- | --- | --- |
| `assets/js/communication/call.js` | Browser | 采集、VAD/barge-in、WS client、播放队列 |
| `assets/js/voice-worklet.js` | Browser | mic → 16k PCM16 + rms |
| `bridge/voice-runtime.js` | Bridge | call session 状态机、ASR/TTS 编排、generation guards |
| `bridge/asr.js` | Bridge | ASR transport（turn-based + opt-in streaming） |
| `bridge/tts.js` | Bridge | TTS provider 注册表 + synthesis + Voice API Source map |
| `bridge/voicebox.js` | Bridge | 外部 Voicebox local runtime adapter |
| `bridge/tts-voices.js` | Bridge | VoiceClone reference-audio 文件基础设施 |
| `assets/js/communication/voice.js` | Browser | voice message 录制/转写/播放 |
| `assets/js/voice-message-core.js` | shared UMD | canonical voice-message contract |
| `assets/js/delivery-*.js` | shared UMD | multi-message turn delivery（非 TTS） |

---

## 3. Voice Call 架构

- Browser 通过 `voice-worklet.js` 采集 mic，并通过 WebSocket 将二进制 PCM 帧流式发送到
  bridge 的 `/voice` endpoint。
- Bridge `voice-runtime.js` 驱动 session 状态机、运行 ASR，并以有序的 sentence unit 合成 TTS，
  同时带有 generation guards。
- Protocol 消息包括 `transcript_partial` / `transcript_final`（bridge→browser）、
  `adapter_reply` / `adapter_reply_sentence`（browser→bridge），以及 `audio` / `generation_end` /
  `interrupted` / `error` / `state`（bridge→browser）。
- 收到 final transcript 时，browser 调用常规 chat 入口（`sendChatMessage({ voiceCall:true,
  transcript, acousticReference, … })`），并将 reply sentences 流式回传给 bridge 以进行 TTS。

---

## 4. Voice Message 架构

voice message 是一个规范性的 chat-message 字段（`voice`），而不是由 Voice-runtime 拥有的 store：

- 由 `assets/js/communication/voice.js` 产生（用户录制），或由 TTS 为 assistant 消息产生。
- 形态由 `assets/js/voice-message-core.js` 定义；参见
  [`../contracts/voice/VOICE_MESSAGE_CONTRACT.md`](../contracts/voice/VOICE_MESSAGE_CONTRACT.md)。
- 作为 chat message 的一部分被持久化；播放来源是 `dataUrl` 或 bridge 的 `audioUrl`，绝不是
  runtime object URL。

---

## 5. ASR 边界

ASR **拥有**：audio capture transport、recognition、transcript generation。
ASR **不拥有**：conversation state、memory 或 model routing。

存在两种 ASR 形态：turn-based `openai-whisper`（默认）与可选的 `streaming` provider
（`voiceAsr.streaming=true`）；未接入 streaming provider 时，runtime 会回退到 turn-based。
provider 是 **config**，不是 architecture（`bridge/config.js voiceAsr`、`bridge/asr.js`）。

---

## 6. TTS 边界

三个彼此不同的概念，绝不合并：

| 层级 | 拥有者 |
| --- | --- |
| Character voice 偏好 | Character configuration（`apiConfigs[].voice`） |
| TTS provider 选择 | Bridge（Voice API Source map） |
| 音频合成 | TTS runtime（`bridge/tts.js` / `bridge/voicebox.js`） |
| 播放 | Browser |

---

## 7. Character Voice 边界

Character voice 是一种**偏好**：它存储在 character config 上，并在 playback/synthesis
时读取（`assets/js/bridge.js` `_ibGetCharVoice`）。它可能携带 `source/provider`、`voiceId`、
`voiceType`、`voiceData`、`voiceStyle` 与 `autoPlay`。它绝不携带 provider credentials，也不
构成 TTS runtime ownership。

---

## 8. Provider 边界

Voice provider authority 与 LLM provider authority 是**分离**的：

```
Voice:  bridge config (tts / ttsMimo / voicebox / voiceAsr) + bridge/tts.js / bridge/asr.js
LLM:    assets/js/provider-directory.js + assets/js/ib-model-core.js
```

browser LLM provider layer 不包含任何 TTS/voice/speech 处理。Voice **不**使用
`provider-directory`。browser 只能看到只读的 source catalog（`/api/tts/sources`），绝不接触
credentials。详情： [`../contracts/voice/VOICE_PROVIDER_SOURCE_CONTRACT.md`](../contracts/voice/VOICE_PROVIDER_SOURCE_CONTRACT.md)。

---

## 9. 音频生命周期

按类型分类——绝不泛化：

| 类型 | 是否持久化？ | 位置 |
| --- | --- | --- |
| Call audio | **ephemeral** | 在内存中流式处理；不持久化 |
| Voice-message audio | **persisted** | chat message `voice.dataUrl` / `audioUrl` |
| VoiceClone reference audio | **persisted** | `DATA_DIR/tts-voices/<id>.<ext>` + `tts-voices.json` registry |
| Cached TTS mp3（bridge） | transient cache | `DATA_DIR/tts`（`/tts/<name>`），按 name-pattern 管理 |

---

## 10. 会话状态

| 状态 | Authority |
| --- | --- |
| recording | browser capture + bridge call session |
| transcribing | bridge ASR session |
| generating | browser chat runtime（model） |
| speaking | bridge TTS queue + browser 播放 |
| interrupted | bridge `call.state` |

Bridge `call.state`（`bridge/voice-runtime.js`）是 call lifecycle 的唯一真相来源
（`idle/connecting/listening/thinking/speaking/interrupting/error/ended`）。browser 为
UI 镜像 state；该镜像不是 authority。

---

## 11. Barge-in

```
User speech (VAD) → browser stops playback → send {type:'interrupt'}
   → bridge interrupt(): state=interrupting, emit 'interrupted' + generation_end(interrupted:true),
     advance generation id, drop stale TTS/ASR chunks
   → resume listening
```

记录到的当前行为：barge-in 会停止播放并推进 generation guard；它不会追溯性地取消已投递的音频。

---

## 12. Memory 边界

Voice **不**拥有 Memory lifecycle（参见
[`MEMORY.md`](MEMORY.md) 与 [`../contracts/memory/`](../contracts/memory/)）。Voice 文件不调用
memory APIs。call transcript 进入**常规 chat runtime**，在那里 memory
retrieval/consolidation 由 memory subsystem 处理。

---

## 13. Middle Brain 边界

依据 [MIDDLE_BRAIN.md](MIDDLE_BRAIN.md)：

- voice-call transcript 进入**常规 chat pipeline**（`sendChatMessage`），因此 MB
  pre-generation（organize/compress）会生效；
- **voice surface 有意绕过 MB Character Integrity guard**
  （`middle-brain-integrity.js` `voice_surface` skip，已测试）。

Voice **不**拥有独立的 Middle Brain path。

---

## 14. 消费者矩阵

| 消费者 | 关系 |
| --- | --- |
| 单聊/群聊 call | 围绕 chat runtime 的 Voice Call |
| Role DM | 使用 role voice 偏好的 call/message |
| Voice Message | chat message 的 `voice` 字段 |
| Delivery (P23) | multi-message turn delivery；非 TTS |
| Middle Brain | 经由 chat pipeline 作用于 transcript（voice 场景绕过 integrity） |
| Memory | 间接，仅经由 chat runtime |
| Mobile | 本文档范围内无 Voice authority |

---

## 15. 配置边界

| Config | Storage | 读取方 |
| --- | --- | --- |
| character `voice` 偏好 | character config `apiConfigs[]` | browser bridge/social；bridge 经由 `source` |
| TTS credentials/endpoints（`tts`、`ttsMimo`） | bridge `config.json` | `bridge/tts.js` |
| Voicebox endpoint | `config.voicebox.endpoint` → env → default | `bridge/voicebox.js` |
| ASR（`voiceAsr`） | bridge `config.json` | `bridge/asr.js` |

credentials 在 `/api/config` 中被遮蔽，绝不抵达 browser。

---

## 16. UI 边界

Voice UI 是一个**配置/控制 surface**，不是 runtime authority：source catalog 展示、
character voice 字段、VoiceClone 上传、voice-message 录制按钮，以及 call modal。Runtime
authority 位于 bridge/browser 的 Voice 模块中。

---

## 17. Non-goals

Voice 不拥有：conversation state、model routing/execution、LLM provider selection、memory
lifecycle、Middle Brain composition 或 provider credentials。它不定义 multi-message turn 的
delivery/timing policy（那属于 delivery contract），也不定义 acoustic reference 算法
（那属于 acoustic reference contract）。

---

## 18. Enforcement

| 关注点 | 测试 |
| --- | --- |
| Call runtime / session | `test_voice_runtime.js`, `test_voice_streaming.js`, `test_voice_reconnect.js` |
| 采集 / 播放 | `test_voice_capture.js`, `test_voice_playback_path.js` |
| Providers | `test_mimo_tts.js`, `test_mimo_voiceclone.js`, `test_mimo_voicedesign.js`, `test_voicebox_provider.js`, `test_tts_voices.js` |
| Source/credential 边界 | `test_voice_source.js` |
| Voice message | `test_native_voice_message.js`, `test_voice_message_lifecycle.js` |
| Acoustic reference | `test_call_acoustic_inject.js` |

runtime 行为由这些测试强制执行；本文档是人类可读的 canonical authority。

---

## 19. 历史参考

仅为 provenance；不是当前 authority：

- `docs/P23-1-VOICE-RUNTIME-FOUNDATION.md`, `docs/P23-2A-MESSAGE-SEQUENCE-CONTRACT.md`,
  `docs/P23-2B-DELIVERY-RUNTIME.md`, `docs/P23-2C-DELIVERY-PLANNER.md`（provisional phase docs）
- `docs/history/legacy/voice-runtime-phase1.md`, `docs/history/legacy/voice-runtime-phase2-3.md`
- `docs/P1-ACOUSTIC-REFERENCE.md`
