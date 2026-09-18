# Companion Proactive Interaction Contract

**Status: Canonical**
**Scope: proactive interaction 词汇表、event shape、call states、dedup、DND**

> proactive interactions 的当前状态 Contract。真相来源：
> `assets/js/proactive-interaction-core.js`（shared UMD，browser + Node）、`active/plan-domain.js`、
> `active/scheduler.js`，以及 `tests/test_proactive_interaction.js` / `test_proactive_phase2.js`。
> frequency/retry 机制见 `AUTONOMY.md`；本 Contract 固定词汇表与 invariants。

---

## 1. Interaction 类型

```
INTERACTIONS = ['text_message', 'voice_call']
```

`normalizeInteraction(value)` 仅当值在白名单中时返回该值，否则返回
`text_message`。**Voice 不是默认值。**

---

## 2. Event 形态

`normalizeEvent(raw)` 产生：

```
{
  eventId, roleId, roleName, avatar,
  interaction,            // text_message | voice_call
  reason, openingMessage, openingLine,
  createdAt,
  callMeta: { conversationId, openingLine },
  status,                 // pending | accepted | declined | dismissed
  actedAt, planId
}
```

- `status` 仅通过 UI actions 推进（`pending → accepted / declined / dismissed`）。
- call metadata 携带 conversation id 与 opening line。

---

## 3. Call 状态

`CALL_STATES = ['idle','incoming','connecting','connected','listening','thinking','speaking',
'interrupting','ending','ended']` 以及一张允许转移表（`canTransition`）。

这些是 inbound/answer/hang-up 阶段的**前端代理状态**。一旦真实的 voice session 开始，
**Voice runtime session state 是唯一真相来源**（见 `VOICE.md` 与
`assets/js/communication/call.js`）。`canTransition` 只约束前端转移；它不会覆盖 runtime authority。

---

## 4. Dedup

- `eventKey` = `roleId | interaction | normalized-opening-text`。
- `isDuplicateEvent(ev, recent)` 将以下情况视为重复：已存在的 **pending** 同 role/同 interaction
  event，或 bigram-Dice 相似度 ≥ `0.82` 的 opening text。
- `textSimilarity` 是共享的 bigram-Dice 度量；`purgeExpired` 保留非 pending events，并让过期的
  pending events 失效（默认 2h）。

---

## 5. DND / Send / Reschedule / Cancel

`active/plan-domain.js` 负责 policy：

- `isInDnd(now, prefs)` / `nextDndFree(now, prefs)` 实现 do-not-disturb window；
- plan 遵守 `cancelConditions.respectDoNotDisturb`、`cancelIfUserReplies`、
  `cancelIfNewerPlanExists`；
- plan evaluation 会返回 **send / reschedule / cancel** 之一，并附带 reason；
- plan lifecycle 为 `scheduled → evaluating → sending → waiting_for_user`，终止状态包括
  `failed`（达到 max attempts）、`cancelled`、`expired`（迟到 > 30 min）。

（完整状态机与阈值见 `AUTONOMY.md`。）

---

## 6. 边界

> AI 可以主动发送消息 **≠** Companion 拥有 message lifecycle。

Companion 负责 plan/execute 与 queue；**Chat Runtime** 拥有 persistence 与 delivery。Voice
委托给 Voice system，不在此处重新实现。

---

## 7. Non-goals

本 Contract 不定义 chat storage/delivery、Voice internals、Moments/Diary/Letter 行为或
relationship state。

---

## 8. Enforcement

| Test | 固定内容 |
| --- | --- |
| `tests/test_proactive_interaction.js` | interaction/event/state 词汇表、dedup |
| `tests/test_proactive_phase2.js` | phase-2 行为 invariants |
| `tests/test_proactive_trace.js` | 仅可观测性（不做决策） |
| `tests/test_active_plans.js` | plan DND/send/reschedule/cancel |

---

## 9. 历史来源

`assets/js/proactive-interaction-core.js`；机制背景见 `docs/AUTONOMY.md`。
