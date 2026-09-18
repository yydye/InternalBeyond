# Voice Acoustic Reference Contract

**Status: Canonical**
**Scope: voice calls 的 Acoustic mood reference 注入**

> 关于在 voice-call turn 期间捕获并注入 LLM request 的 request-local acoustic mood reference 的
> 当前状态 Contract。Sources：`assets/js/communication/call.js`
> （`_acousticReferenceFor`）、`assets/js/communication/voice.js`（`_vmToneAnalyze`）、
> `docs/P1-ACOUSTIC-REFERENCE.md`，以及 `tests/test_call_acoustic_inject.js`。

---

## 1. 它是什么

一段简短的文本 "acoustic mood reference"，派生自**当前 turn** 累积的 PCM +
transcript，附加到 request 上，以便 model 能感知 caller 的 tone。它是 request-local 的，
且只描述*当前* turn。

---

## 2. 范围（硬性）

- **只注入 LLM request**。
- 它**不是** ASR Contract，也**不是** TTS Contract。
- 它不修改或绕过 ASR/TTS 边界；它与 transcript 一起被携带。
- 它绝不持久化 audio：reference 由当前 turn 的内存中 chunk 计算得出，并在该 turn 之后
  释放。

---

## 3. 条件

`_acousticReferenceFor(roleCfg, chunks, transcript)` 在以下情况返回 `''`（无 reference）：

- tone helpers 不可用；
- 没有 chunk / 零 bytes；
- 派生出的 tone 为空；
- role 是 **audio-native**（`_vmAudioNative(roleCfg)` 为 true，或 `roleCfg.audioInput === true`）——
  这种情况下 model 直接接收 audio，不注入任何 text reference。

否则它返回 tone 字符串。

---

## 4. 单一实现

`_vmToneAnalyze` 是**唯一**的 algorithm 实现；`docs/P1-ACOUSTIC-REFERENCE.md` 记录
了该 fork 的 upstream 曾拥有它，而本 fork 恰好保留一个实现。没有重复的 analyzer。

---

## 5. 消费者

voice call 是唯一的消费者：`call.js` 在 `onTranscript` 处调用该 helper，并将结果作为
`acousticReference` 传入 `sendChatMessage`。

---

## 6. Non-goals

本 Contract 不定义 tone algorithm 本身，不持久化 analysis，也不适用于 voice messages。

---

## 7. Enforcement

| 测试 | Pins |
| --- | --- |
| `tests/test_call_acoustic_inject.js` | 注入条件 / 非注入场景（P1 stage 2） |
| `tests/test_voice_pcm_adapter.js` | reference 使用的 PCM → audio-like adapter |

---

## 8. 历史引用

`docs/P1-ACOUSTIC-REFERENCE.md`；`assets/js/communication/call.js`。
