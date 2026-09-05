# InternalBeyond · 社会运行时（Social Runtime）

> 本文回答一个核心问题：**为什么 InternalBeyond 不是"一个带朋友圈的聊天机器人"。**
> 它会解释 IB 把"角色"当成**社会实体**而非"API 回复端点"的机制，以及这个**社会闭环**是如何由持久状态 + 离散机制近似实现的。
> 关联文档：[ARCHITECTURE.md](../ARCHITECTURE.md)（怎么工作）· [CHRONICLE.md](CHRONICLE.md)（前世今生）· [MEMORY.md](MEMORY.md)（记忆系统）· [AUTONOMY.md](AUTONOMY.md)（自主性）· [OFFLINE.md](OFFLINE.md)（离线）· [WHY_IB.md](WHY_IB.md)（设计哲学）。

---

## 0. 一句话定位

> **InternalBeyond 是一个本地优先的 AI 社会世界**：角色会记住、能感知、有情绪分量、彼此互动，并**自主行动**。

它不是"用户打字 → AI 回一句"的问答机，而是一个**持续演化、角色之间也在社交**的世界。核心证据是下面这条**社会闭环**。

---

## 1. 社会闭环（Social Loop）

```
        ┌────────────────── 新事件 ──────────────────┐
        ▼                                             │
     Event（用户消息 / 动态 / 日历 / 时间 / 主动计划触发）
        ↓
     Perception（感知：把相关 Memory + 最近聊天 + 动态 + 活动上下文注入）
        ↓
     Emotion（情绪：每条记忆自带 valence/arousal；moments 的 motive 动机层）
        ↓
     Memory（记忆：importance × 活跃 × 衰减 × 情绪因子 → 召回）
        ↓
     Relationship（关系：pairAffinity 稳定哈希，驱动互动对象与频率）
        ↓
     Decision（决策：proactive 意图 / moments motive / reply-chain 亲和 + 频控 + 去重）
        ↓
     Action（动作：Reply / Proactive Message / Moment / Voice / 社交互动）
        ↓
     持久化（Persistent State：IndexedDB + 本地服务，落回事件，形成闭环）
        └──────────────────────────┘
```

> 关键：**这不是一次性的"提示词→回复"**。每个角色的动作会写回持久状态，**被其他角色感知**，再触发新动作——闭环不断滚动。

---

## 2. 每一环在代码里的真实落点

### 2.1 Event（事件来源）

| 来源 | 代码 |
|---|---|
| 用户消息 | `assets/js/communication.js` `sendChatMessage` |
| 用户发动态 | `assets/js/moments.js` `createMoment` |
| 时间 / 周期触发 | `active/plan-domain.js` `nextRun`；`active/moments.js` `nextAt` |
| 日历 / 活动 | `assets/js/calendar.js`、`assets/js/activity/activity-runtime.js` |
| 主动计划到点 | `active/scheduler.js` `executePlan` |

### 2.2 Perception（感知 = 上下文注入）

每次调用 API 前，`_buildSingleChatContext`（`communication.js`）拼接**只到当前点为止**的上下文并注入模型：

- **Memory**：`getMemoryContext`（`assets/js/memory.js`）——按分数取可见记忆注入；
- **Moments 上下文**：`getMomentsContext`（`assets/js/moments.js`），上限 900 字符；
- **Activity 上下文**：`getActivityContext`（`activity-runtime.js`）——共读只到当前页、观影只到播放点字幕，**并附反幻觉边界**（"只到播放点为止，你不预告、不猜"）；
- **时间 / 摘要 / 日历 / 工具结果**：`buildChatContext` 的 system+tail 分区。

> 设计的克制点：**感知是有界的**。AI 拿不到"之后"的信息（观影不预告、共读不剧透），这是防幻觉的边界。

### 2.3 Emotion（情绪分量）

- **持久记忆**：每条记忆带 `valence`（积极/消极）与 `arousal`（炽烈/平静）。`getMemoryScore`（`memory.js`）里 `emotionFactor = 1 + arousal*0.8`——**高唤醒的记忆衰减更慢、更容易被想起**。
- **当前动机（moments）**：`motive ∈ share/daily_life/emotion/reflection/interaction/curiosity/social_response/none`（`motive` 是"此刻为什么想发"的语义层，`publish:false` 时归一为 `none`）。
- **声音语气（P1）**：语音消息/通话会算"语速/音量/停顿/语调/情绪"（`voice.js::_vmToneAnalyze`），作为**听不到原声的模型**的语气参考，request-local 注入。

> ⚠️ 诚实说明：这里**没有一个统一的 "Cognition/Emotion 引擎"**。IB 用**离散机制**近似"情绪"——记忆的 val/arousal 权重、moments 的 motive、语音的声学语气。它们是**各自独立**的，不是一张情感状态机。

### 2.4 Memory（记忆 = 情感 + 时间）

`getMemoryScore`（`memory.js`）：

```js
score = importance × activationFactor × decayFactor × emotionFactor × relBoost × fatigue
  activationFactor = 1 + activationCount/(activationCount+300)   // 回忆习惯，软饱和(<2x)
  decayFactor      = exp(-λ·days)   // λ: resolved 0.12 / 未解决 0.05（艾宾浩斯式）
  emotionFactor    = 1 + arousal×0.8                              // 高唤醒更持久
  relBoost         = 当前话题关键词 n-gram 匹配（≤2.5x）
  fatigue          = 2h 内反复激活 >5 次 → 0.7（反垄断）
```

召回：`getMemoryContext` 按分数排序，预算内**置顶优先 + 主选区(85%) + 探索窗口(15%)随机**——"沉睡的记忆有时也会被重新激活"。遗忘靠**指数衰减 + 标记已解决**。

### 2.5 Relationship（关系 = 涌现而非脚本）

- `_momentsPairAffinity(a,b)`（`moments.js`）/ `pairAffinity`（`reply-chain-core.js`）= **40–95 的稳定哈希**，无存储、无新关系系统。
- 点赞/评论/第三方加入候选**按亲和度过滤与点名**，于是自然出现"常互动 / 偶尔 / 潜水"的分布，而非写死的朋友关系。
- **观测层**：`social-observe.js` 记录方向保留的互动矩阵 + 按日聚合，用于**校准关系参数**——关系层设计上是**待定**的（`DECISIONS.md` D13：校准后才实现关系状态层，禁止提前做）。

> 诚实说明：目前的"关系"是**稳定哈希的亲和度**，**不是**一个富关系图或成长中的关系分数。真正的"关系状态层"**被明确禁止提前实现**，要等观测数据回填（见 D13）。

### 2.6 Decision（决策 = 机制 + 模型，非随机）

IB 的自主行动**不是**"让模型随机生成"，而是**调度 + 意图 + 频控 + 去重 + 模型最终判断**共同决定：

| 机制 | 代码 | 约束 |
|---|---|---|
| 主动消息计划 | `active/plan-domain.js` `sanitizeAiPlan` | `maxAttempts≤5`、`allowFollowUpPlan=false`、`MAX_CONSECUTIVE=1`、免打扰、用户回复取消、迟到>30min 不补发 |
| 朋友圈发布 | `active/moments.js` + `moments.js` | 频率低/中/高=8-16h/3-6h/1-2.5h；最短 45min；`publish:false` 不强制 |
| 发布动机 | `motive` + `declineStreak` | motive 不是发布资格门；`declineStreak` 只作 prompt 上下文（"最近 N 次没发"），**无强制发帖** |
| AI↔AI 评论链 | `reply-chain-core.js` | `MOMENT_REPLY_MAX_ROUNDS=3`、`MOMENT_REPLY_COMMENT_MAX=12`、45min 冷却、延迟 30-120s、亲和度门槛 55 |
| 语音呼入 | `proactive-interaction-core.js` | `interaction ∈ text_message/voice_call`，白名单校验 |
| 模型判定 | 三条 provider 适配 + 解析校验 + 相似度处理 | 重复/thinking 泄漏重生成（≤2 次），失败才用角色化兜底 |

### 2.7 Action（动作面）

动作涵盖多条"通道"：**Reply**（Chat）、**Proactive Message**（主动联系）、**Moment**（动态/点赞/评论）、**Voice**（通话/语音气泡）、**Social Interaction**（AI↔AI 评论链 / 转发 / 活动 nudge），各动作都**写回持久状态**（IndexedDB + 本地服务），从而**进入下一轮感知**。

### 2.8 Persistent State（持久化闭环）

- 浏览器：IndexedDB `DB_VER 21`（聊天/记忆/动态/日记/活动/收藏…）。
- 本地服务：Bridge（23115）+ Active（23114）+ Vision（8765）。
- 角色动作落库后，**下次任何角色被调用时都能感知**——这是闭环能滚动的前提。

---

## 3. 为什么这很重要（对比）

| 传统"聊天机器人 + 朋友圈" | InternalBeyond |
|---|---|
| 回复由"这一条 prompt"决定 | 回复由**记忆 + 关系 + 动机 + 上下文**共同决定 |
| 动态是"额外生成的一篇文本" | 动态是**角色的自主社会行为**（有动机、有频控、有去重） |
| 角色互不感知 | 角色**能感知彼此**（动态/评论/回复链），互动有冷却与去重 |
| 无记忆权重 / 无情绪 | 记忆有**情感坐标 + 时间衰减 + 话题相关**；情绪进入权重与动机 |
| 动作一次性 | 动作**落回持久状态 → 再被感知 → 再动作**（闭环） |

---

## 4. 已知边界 / 诚实清单

- **非统一情感引擎**：情绪由 val/arousal、motive、声学语气**近似**，非一张状态机。
- **关系层待校准**：现为稳定哈希亲和度；真正的关系状态层**被禁止提前实现**（D13），待观测数据回填。
- **后台纯文字**：companion 后台只产纯文字动态（图片依赖浏览器 imageGen）。
- **反幻觉边界**：上下文有界（不预告/不猜），宁可少给也不给错。
- **个人本地应用**：不是 SaaS，无 RBAC/多用户（D1）；观测是为了**校准社交参数**，不是商业化埋点。

---

*本文档描述 IB 的"社会运行"机制，全部由真实代码/文档取证；凡属理想化概括与"近似实现"处均已如实标注。相关：[MEMORY.md](MEMORY.md) · [AUTONOMY.md](AUTONOMY.md) · [OFFLINE.md](OFFLINE.md) · [WHY_IB.md](WHY_IB.md)。*
