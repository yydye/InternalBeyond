# Voice Delivery Contract

**Status: Canonical**
**Scope: Multi-message turn Delivery（sequence、planning、timing、cancel）**

> 关于将单个 assistant turn 转为 N 条 canonical chat messages 并随时间交付的当前状态 Contract。
> Sources：`assets/js/delivery-sequence-core.js`（Phase 2A）、
> `assets/js/delivery-planner.js`（Phase 2C）、`assets/js/delivery-runtime.js`（Phase 2B），以及
> `tests/test_message_sequence_contract.js`、`tests/test_delivery_runtime.js`。
> 这是一个 **chat-message delivery** Contract，不是 TTS Contract。

---

## 1. Model

一个 model turn 可以产生 **N 条独立的 canonical chat messages**（一个 "unit" = 一条 canonical
`chatMessage`）。Delivery Contract 只回答*哪些 unit、以什么顺序、在什么时间、处于什么
state*。

---

## 2. Sequence Shape（Phase 2A）

```
{
  mode: 'single' | 'sequence',
  units: [ { kind: 'text', content: '…' }, … ],
  segments: [ … ],
  policy: { … },
  stats: { … }
}
```

- `validate(sequence)` 强制该 shape。
- `buildMessages(sequence)` 确定性地产生 canonical `chatMessages[]`。
- `orderMessages()` / `compareMessages()` 给出确定性顺序。
- 该 core **不包含**任何 runtime、DOM、timers、provider 或 TTS 知识。

---

## 3. Planner（Phase 2C）

Delivery Planner 将单个生成的 assistant turn 映射为 delivery sequence。它**唯一**的
职责是 content structure —— 它不决定时间、不持久化、不渲染、不调用 model、不调用
TTS，也不使用任何 randomness 或 wall clock。

---

## 4. Runtime（Phase 2B）

Delivery Runtime 是随时间交付已构建 sequence 的唯一 authority：

- unit states：`queued → delivering → completed | cancelled | failed`；
- 给定注入时间（`now` / `setTimeout` / `clearTimeout`）时，per-unit timing 是确定性的；
- typing 通过注入的 `onTyping` callback 呈现（模块不触碰 DOM）；
- `cancel`（user interrupt / stop）只取消**尚未交付**的 unit —— 已交付的 unit
  会被保留；
- 新的 generation 在与 user interrupt 相同的 "new utterance" 语义下取代进行中的 generation。

---

## 5. 边界

| 组件 | 拥有 | 不拥有 |
| --- | --- | --- |
| `delivery-sequence-core.js` | sequence 校验、确定性 message build/order | timing、storage、TTS |
| `delivery-planner.js` | content structure（turn → sequence） | timing、persistence、rendering、model |
| `delivery-runtime.js` | delivery timing/order/state/cancel | content selection、TTS、DOM |

Delivery 不选择 voice vs text vs image（那是 planner/upper-layer content），也不
合成 audio。

---

## 6. Non-goals

Group runtime、proactive-message policy 变更、emotion planner、personality rewrite、大规模 chat
schema migration、Voicebox streaming，以及 image generation planning 都在本 Contract 之外。

---

## 7. Enforcement

| 测试 | Pins |
| --- | --- |
| `tests/test_message_sequence_contract.js` | sequence shape / build / order |
| `tests/test_delivery_planner.js` | turn → sequence content planning |
| `tests/test_delivery_runtime.js` | timing, state machine, cancel semantics |

---

## 8. 历史引用

Phase provenance：`docs/P23-2A-MESSAGE-SEQUENCE-CONTRACT.md`、
`docs/P23-2B-DELIVERY-RUNTIME.md`、`docs/P23-2C-DELIVERY-PLANNER.md`。
