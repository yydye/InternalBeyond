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
      advance generation id, abort active provider signal, clear queued sentences
    → resume listening
```

取消分两层：

- **Logical cancellation**：generation guard 使旧 TTS/ASR/audio 永远不能发出或播放。provider cancel 失败也不改变此保证。
- **Physical/provider cancellation**：TTS request 携带 session、generation、sentence、request identity 和 `AbortSignal`。provider 通过 registry 的 `supportsCancellation` 声明能力；未声明的 provider 仍使用 logical cancellation，不要求实现 `cancel()`。
- **Voicebox**：适配器把本次 IB request 与 Voicebox generation ID 关联；signal abort 后 POST `/generate/{id}/cancel`，停止 history polling / audio download，并阻止创建 Bridge TTS artifact。若 `/generate` 尚未返回 ID，受独立 timeout 约束的提交握手会继续到拿到 ID，再立即请求取消；该竞态中 synthesis promise 会先返回 cancelled，不阻塞下一轮。
- **Queue ownership**：Bridge TTS drain 按 generation 独占。旧 drain 在 await 后发现 generation 已替换就退出，只能删除自己的 owner；它不能取走新 generation 的 queue 项，也不能清除新状态。

目前只有 Voicebox 声明支持物理取消。Edge、OpenAI-compatible 和 MiMo 保留原行为并继续依靠 stale-result guard。Voicebox 仍然只是 TTS provider，不获得 Persona、Agent 或 final-text authority。

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

### 16.1 Voicebox Profile 生命周期

Profile 的所有权保持在 Voicebox：Voicebox 保存 profile、参考音频、transcript 与声学数据；
Project-IB 的角色只保存 canonical external reference：

```text
apiConfigs[].voice.source = "voicebox"
apiConfigs[].voice.voiceId = <Voicebox profile ID>
```

IB 不复制 profile、sample、`audio_path`、personality 或模型状态。Voicebox UUID 在同一数据库
中用于 profile 查找；Voicebox export/import 可能生成新 ID，因此它不是跨安装永久标识。IB 不按
名称自动修复引用：缺失 ID 显示为“音色不可用”，用户从当前 profile 列表显式重新绑定。

profile 管理只经由 IB Bridge；Browser 不直接请求 Voicebox localhost。Bridge 对 profile 和 sample
响应做白名单清理，参考音频通过内存中的受限二进制请求转发，不传文件路径，也不保存在
`DATA_DIR/tts-voices`。当前 IB 上传范围为 WAV/MP3、2–30 秒、最多 10 MiB；浏览器本地预览和
Bridge 分别校验，Voicebox 再执行其自身音频校验。录音复用 `assets/js/communication/voice.js`
的 MediaRecorder 状态机，停止后在本地转换为 WAV 预览；参考录音不走 `voiceTrans`、聊天发送、
Memory 或 Middle Brain。

Voicebox 把克隆 profile 与预设 profile 分开。Bridge capability map 按上游
`jamiepine/voicebox` `main` 的 `backend/services/profiles.py`、`backend/routes/profiles.py`、
`backend/routes/audio.py`、`backend/models.py` 与 `backend/backends/__init__.py` 审计，基线为
`51f49dea198384b4eb6087b72c17057c6eb1c1cd`。克隆引擎为 `qwen`、`luxtts`、`chatterbox`、
`chatterbox_turbo`、`tada`；预设引擎为 `qwen_custom_voice`、`kokoro`。UI 依据这张 capability
map 展示选项，不由 browser 根据 engine 名称猜能力。Voicebox 要求参考样本带有非空 transcript。
创建克隆音色通过 Bridge 分两步执行（创建 profile，再上传/处理样本）；样本失败后尽力删除，
清理失败时显示可修复或删除的不完整 profile。

试听通过现有 `/api/tts` provider seam 并设置 `preview: true`；不会创建聊天消息或更改角色配置。
Bridge 先只读检查 `/models/status`；所需模型缺失或状态不可读时拒绝试听，也不会启动模型下载。
Voicebox generation 始终发送 `personality: false`；Persona、最终文本、自动播放与何时发声仍由 IB
决定。只有经过 capability map 确认支持 `instruct` 的 engine 才会收到该字段。

已存参考样本通过 Voicebox `GET /samples/{sample_id}` 读取。Bridge 最多在内存代理 10 MiB 音频
字节到 Browser，不返回 sample `audio_path`，也不在 IB 文件系统中落盘。

删除 profile 前会列出当前引用该 ID 的活跃与归档角色。确认删除后不会重写这些角色，也不会选择
同名替代音色；原引用会保留为 dangling 状态，等待用户显式重新绑定。

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
| Voicebox profile lifecycle / local reference recording | `test_voicebox_profile_lifecycle_ui.js` |
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
