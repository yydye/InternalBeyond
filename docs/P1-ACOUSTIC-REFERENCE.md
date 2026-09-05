# P1 · 声学语气参考（Acoustic Mood Reference）· 定稿

> 本文档记录把「声学语气参考」接入本 fork 的**最终方案**（A 方案）。区别于早期草案（曾计划新建独立 `assets/js/acoustic-reference.js`），定稿为**复用项目已有的 `voice.js::_vmToneAnalyze` 唯一算法核心**，不再引入第二份实现。
> 定位：**独立能力，不属于 Call；浏览器侧分析；不改变 ASR/TTS 契约；只在当轮 LLM 请求注入。**

---

## 0. 最终架构（P1 第一阶段已落地）

```
voice-worklet.js  IBVoiceCapture → postMessage {pcm(Int16@16k), rms}
        ↓ PCM（浏览器 call.js 已持有）
call.js          当前 turn 累积 Int16 PCM
        ↓ 适配
voice.js::_vmPcmToAudioLike(pcm, sampleRate)   ← 唯一适配层（第一阶段新增）
        ↓ AudioBuffer 兼容壳
voice.js::_vmToneAnalyze(ab, transcript)        ← 唯一声学算法核心（既有，复用）
        ↓
[Acoustic reference] 块（仅进 LLM request，不进持久化）
        ↓
现有 LLM → 现有 TTS
```

## 1. 要点（A 方案定稿）

- **`voice.js::_vmToneAnalyze` 是唯一声学算法核心**。不复制、不重写。
- **`voice.js::_vmPcmToAudioLike()` 是 Call PCM → analyzer 的唯一适配层**（第一阶段新增）：把 16kHz 单声道 Int16 PCM 包成 `_vmToneAnalyze` 可消费的最小 AudioBuffer 兼容壳（`length/duration/sampleRate/numberOfChannels/getChannelData`），纯函数、零副作用。
- **删除独立的 acoustic-reference 模块**（旧草案产物，已移除）。
- **tone 只用于 LLM request**：绝不进入 UI transcript、chat history、Memory、persisted message。启用现有 `_vmAudioNative(cfg)` 判定——audio-native 模型（Gemini / GPT-Audio / Omni / 含 audio 模型名）跳过语气参考；非 audio-native 模型才注入 `[Acoustic reference]…[/Acoustic reference]`。
- **不透传 `userMsg.voice`**：不绕现有 voice.js 录音消息路径（那条路径会持久化 tone，本方案不沿用）。
- **PCM 分析后立即释放**；绝不落盘。

## 2. 注入点（第二阶段 Call 注入）

见 §3 与 `call.js` 的 `onTranscript → sendChatMessage` 链路。tone 块仅在**发给 LLM 的 messages** 上附加，与存储的 `userMsg` 完全解耦。

## 3. 设计说明（第二阶段定稿前的关键工程约束）

- 触发：`call.js` 收到 `transcript_final`（`onTranscript`）时，对**当前 turn 累积的 Int16 PCM** 分析一次。
- 判定：`cfg.audioInput === true` 或 `_vmAudioNative(cfg)` 为真 → 跳过；否则注入。
- 守卫：无 PCM / 静音（返回空）/ 过短（<0.6s）→ `_vmToneAnalyze` 返回空串 → 不注入（不产生伪造 tone）。
- **持久化与注入的分离**：`sendChatMessage` 中 `transcript` 既写入 `userMsg.content`（持久化）又进入模型 `messages`。**若把 tone 附加进 `transcript`，tone 会被持久化**（违反"绝不进入 chat history / persisted message"）。因此正确落点是**模型侧 `messages` 数组**（由 `history.map` 从存储构建的新对象，非 `userMsg` 本体），在那里附加 tone 块即**模型专有、不持久化**——与既有 `[系统注入参考上下文]` tail 注入（communication.js:1868）同构。这一步需要一处**最小化 `communication.js` 缝**（读一个 request-local 选项并仅附加到 `messages` 末条 user 消息），已在第二阶段实现清单中标注。
- 边界：不改 `bridge/*`、`voice-worklet.js`、WS 协议、`voice.js::_vmToneAnalyze`；不做其他重构。

---
*本文档只描述决策与实现边界，不含密钥。实现见 CHANGELOG 与新增测试。*
