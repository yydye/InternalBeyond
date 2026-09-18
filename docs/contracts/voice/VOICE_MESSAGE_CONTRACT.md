# Voice Message Contract

**Status: Canonical**
**Scope: canonical chat-message `voice` 字段**

> 关于 voice message 的当前状态 Contract。派生自 `assets/js/voice-message-core.js`（UMD，
> 由 browser 与 Node 共享）。它只定义对象 shape —— 不涉及 I/O、storage、transport 或
> provider 判断。

---

## 1. 字段

`voice` 是 canonical chat-message 字段（`chat-core.js` `CONDITIONAL_FIELDS`；`validateMessage`
要求它是一个对象）。本 Contract 定义该对象的 shape。

---

## 2. 形状

User recording（必须逐字保留）：

```
{ dataUrl, mime, duration, transcript, tone }
```

Assistant (AI) voice message：

```
{
  dataUrl,        // inline audio; '' if absent
  audioUrl,       // bridge local reference (/tts/<id>.<ext>); '' if absent
  mime, duration, transcript,
  contentHash,    // optional: fingerprint of the content this audio was generated from
  provenance: { source, provider, engine, model, voiceId, voiceType, refAudioId, profile }
}
```

- `dataUrl` 与 `audioUrl` —— 消息的 voice 要有效，**至少需要其中一个**；大于
  `INLINE_MAX_BYTES`（2,000,000 bytes）的 inline audio 会降级为 bridge reference，或者该 voice
  被整个丢弃（绝不会出现没有 source 的 "playable" voice）。
- `mime` 默认取自 URL/extension（`audio/mpeg` fallback）；`duration` 是正数或 0。

---

## 3. Provenance（硬性安全边界）

`provenance` 是一组**扁平、白名单、标量**集合：
`source, provider, engine, model, voiceId, voiceType, refAudioId, profile`。

- 未知 key、嵌套对象和空值会被丢弃。
- 任何 secret 形状的 key（`apikey|api_key|secret|token|authorization|password|credential|bearer`，
  大小写不敏感）以及任何 bearer/`sk-` 值都会被拒绝 —— 在任何嵌套层级。
- `bridge/tts.js` credentials 和 endpoints 永远不会进入消息。

---

## 4. Freshness / Lifecycle

- `contentHash` 记录该 audio 由之生成的内容（`contentFingerprint`）。
- 当 `voice.contentHash` 不再匹配 `contentFingerprint(msg.content)` 时，`isStale(msg)` 为 true；
  没有 `contentHash` 的 record 采用 fail open（可渲染）。
- **任何重写 assistant content 的路径都必须调用 `dropVoice(msg)`**（immutable 语义：删除
  voice，而不是让 text 与 audio 分叉）。`isAiVoiceMessage(msg)` 要求非 user 消息上存在
  非 stale、playable 的 voice。

---

## 5. Playback Source

`playSrc(voice)` 是唯一的 resolver：先 inline `dataUrl`，再 bridge `audioUrl`，否则 `''`。
它从不返回 object URL —— source 必须在 reload 后仍然存在。

---

## 6. Persistence 边界

voice 对象**作为 chat message 的一部分**被持久化。它不是独立的 store，也不归 Voice runtime
所有。

---

## 7. Non-goals

本 Contract 不定义 chat message routing、delivery/timing、provider selection，或
acoustic reference algorithm。

---

## 8. Enforcement

| 测试 | Pins |
| --- | --- |
| `tests/test_native_voice_message.js` | canonical shape、provenance 白名单、secret 拒绝、build/playSrc |
| `tests/test_voice_message_lifecycle.js` | 生命周期（stale/drop voice、closure 修复） |
| `tests/test_voice_playback_path.js` | playback source 路径 |

---

## 9. 历史引用

`assets/js/voice-message-core.js`（P23 Phase 1）。Phase provenance：
`docs/P23-1-VOICE-RUNTIME-FOUNDATION.md`。
