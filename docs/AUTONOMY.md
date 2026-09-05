# InternalBeyond · 自主性（Autonomy Runtime）

> 本文定义 IB 的**自主行为机制**：它如何让角色"自己行动"，以及为什么这是**有节制的自主（Autonomy ≠ random generation）**。
> 关联：[SOCIAL_RUNTIME.md](SOCIAL_RUNTIME.md)（社会闭环）· [MEMORY.md](MEMORY.md)（记忆）· [ARCHITECTURE.md](../ARCHITECTURE.md) · [DECISIONS.md](../DECISIONS.md)（D11/D13）。

---

## 0. 核心论断

> **自主 ≠ 随机生成。**

IB 的自主行为是**"调度约束 + 意图 + 频控 + 去重 + 模型最终判断"**共同决定的，不是让模型随机想说啥就说啥。决策输入：

```text
State（角色/关系/记忆/最近聊天/最近主动消息）
 + Time（当前时刻/距上次互动）
 + Relationship（亲和度哈希）
 + Memory（评分召回）
 + Emotion（valence/arousal · motive 动机）
 + Goals（本次主动性：下一句想达到什么）
        ↓
   Autonomous Decision
        ↓
  Reply / Proactive Message / Moment / Voice / 社交互动
```

每个"自主动作"都有**边界**（频控、冷却、去重、取消条件）——这是 IB 与"无限刷屏 agent"的本质区别。

---

## 1. 主动消息（Proactive Messaging）

**数据流**（浏览器 + 本地服务双执行器一致）：`sendChatMessage` 回复保存后 → `_activeMaybePlanNext` → `planNextProactiveMessage`（`callApiChat` jsonMode + 白名单校验）→ `_activeSaveAiPlan` → 落库 → 调度器。

**状态机**（`active/plan-domain.js` `sanitizeAiPlan` / `active/scheduler.js` `executePlan`）：

```
scheduled → evaluating(原子抢占) → sending → waiting_for_user
                ↓                        ↓
           failed(达 maxAttempts)   cancelled(用户已回复) / expired(迟到>30min)
```

**约束 / 取消条件**（`sanitizeAiPlan` 白名单）：

```js
constraints: { maxAttempts≤5, allowReschedule, allowFollowUpPlan:false }
cancelConditions: { cancelIfUserReplies:true, cancelIfNewerPlanExists:true, respectDoNotDisturb:true }
prefs: { maxConsecutive:1 /* 用户未回复只发一条 */, dndStart:'23:00', dndEnd:'08:00', minIntervalMinutes, maxPlanHours }
```

**生成**（`active/model-client.js` `buildProactivePrompt` / `generateProactiveMessage`）：角色设定 + 关系 + 当前时间 + 距上次聊天 + 最近聊天摘要 + 相关记忆 + 最近已发主动消息 + 本次目的（`proactiveModeGuide`：greeting/memory/time/random）+ 用户附加要求；`brevity-policy` 让它 1–2 句。

**重试 / 去重 / 兜底**：
- 相似度校验 `validateProactiveReply`：与最近主动消息相似度 ≥ 上限、或相同开头 → 拒绝并重生成（`retryInstruction`）；
- **thinking 泄漏**：返回 think/analysis 标签 → 拒绝；
- 重试 ≤ `maxAttempts`，全失败才用**角色化兜底**（按角色画像分池，标记 `generatedByFallback`）。

---

## 2. 朋友圈调度（Moments Scheduler）

角色按频率**自主发布**，同样受调度与去重约束（`moments.js` + `active/moments.js` 双端镜像）：

- **频率**：低/中/高 = 8–16h / 3–6h / 1–2.5h 随机区间；**最短 45min**（`lastPostAt`）。
- **决策层**：`publish:true/false` 由模型判断，**`publish:false` 不强制**（正常输出，不是失败）。
- **动机层**：`motive`（share/daily_life/emotion/reflection/interaction/curiosity/social_response/none）——**不是发布资格门**，只影响"此刻为什么想发"。
- **declineStreak**：连续未发计数，只作为 prompt 上下文"最近 N 次你都没发"，**无强制发帖**。
- **抗空泛**：Prompt 规则 3 拒绝"无具体人事物支撑"的空泛模板。
- **去重 / 冷却**：同作者去重、频率 + 45min 冷却。

---

## 3. AI↔AI 互动（回复链）

`assets/js/reply-chain-core.js`（UMD 前后台同源，规则零分叉）：

```text
发帖 → 首层评论 → 作者回评 → 第三方加入 → 再回复
```

- **轮数**：`MOMENT_REPLY_MAX_ROUNDS=3`（单线程最多 3 轮回复层）、`MOMENT_REPLY_COMMENT_MAX=12`。
- **节流**：延迟 30–120s 一步；每小时/每日 4/12；第三方门槛**亲和度 55**（`pairAffinity`）。
- **冷却**：45min 评论冷却——**同一角色在快速链中只发言一次** → 自然"多角色轮流接话"、不刷屏（D11）。
- **一次一步 + 执行前释放槽位**：`_momentsMaybeReplyChain` 是唯一入口，pending 保证同时只有一个计划，**先释放槽位再排下一步**——链条能延续而不死锁。
- **幂等三层**：lastConsumedCommentId 拒绝重复消化；仅最新一条评论可推进；pending 拦截并发。

---

## 4. 主动语音呼入（Voice Interaction）

`proactive-interaction-core.js`：`interaction ∈ text_message | voice_call`（默认 text_message，**语音不是默认项**——只有模型判断"适合直接说两句"才选）。`voice_call` 计划由浏览器独占执行，生成开场词 → 来电卡（接听/拒绝/忽略）；接听进入现有 Voice Runtime，拒绝则取消计划并更新事件状态。复用 `_activeValidatePlanResult` 白名单校验，不新建第二套 Chat/Memory/Voice runtime。

---

## 5. Heartbeat / 调度（谁在驱动）

- **浏览器**：`_activeTick`（30s）驱动主动消息、日记、Moments 前端调度。
- **companion**：`switch` 的 `schedulerTick`（在 `active/scheduler.js`，`IB_RESIDENT_TICK_MS` 可调）。
- **互斥**：companion 在线且能力支持 → **后台独占**（浏览器 tick 不本地生成，只节流快照同步）；companion 离线/旧版 → 浏览器本地执行（`claimUntil` 认领锁防双标签）。**无双执行器双发**（主动消息 plans 例外：靠四层防重复）。

---

## 6. Offline 降级（浏览器关闭 / 模型不可用）

| 场景 | 降级路径 |
|---|---|
| 浏览器关闭 | **Active 服务**（`active-message-service.js`）继续执行已授权计划；浏览器重开时 reconcile 对账 |
| companion 离线/旧版 | 浏览器**本地回退**执行（`claimUntil` 锁），不双发 |
| 云端模型不可用 | `Ollama / LM Studio / vLLM` 本机模型预设（回环端点，可无 Key）|
| 生成链路失败 | 两次重试 → `generatedByFallback` 角色化兜底 |
| 页面离线 | 本地优先中心：文件解析库缓存离线上可用；Python/Pyodide 需本地副本 |

（完整"真降级 vs 有本地模式"见 [OFFLINE.md](OFFLINE.md)（规划中）。）

---

## 7. 自主动作一览

| 动作 | 驱动 | 边界 |
|---|---|---|
| Reply | 用户消息 | 上下文有界（反幻觉） |
| Proactive Message | 计划 + 意图 + 频控 | `MAX_CONSECUTIVE=1`、DND、去重、≤2 次重试 |
| Post Moment | motive + 频率 + 模型 | 最短 45min、`publish:false` 不强制 |
| 点赞/评论/转发 | 亲和度 + 冷却 + 去重 | 4 赞/小时、45min 冷却、同作者去重 |
| AI↔AI 回复链 | reply-chain | 轮数 3、评论 12、冷却 45min、一次一步 |
| Voice Call（呼入/呼出） | proactive interaction | 白名单、非默认 |
| Activity nudge（共读/观影） | `IB.activity.nudge` | 8 分钟冷却、幂等 |

---

## 8. 已知边界 / 诚实清单

- **无长时程规划**：IB 的"自主"是**单步/短程**的——一次计划、一次发布、一轮回复链，**没有**多步目标规划或自由 agent 循环。
- **强烈克制**：`allowFollowUpPlan=false`、`MAX_CONSECUTIVE=1`、`motive` 非发布资格门、`declineStreak` 无强制——**作者刻意把"暴走/刷屏"焊死**（对应 `INTERNALBEYOND_AI_RULES.md` §3/§9 的"不越权、不做企业级"）。
- **无内容级 OOC 防火墙**：边界是**schema/频率/取消条件 + prompt 约束**，**不是**生成后的人设一致性审查（详见此前 P1 讨论）。
- **观测先行**：关系层待 `social-observe.js` 校准后才实现（D13），自主性参数同样**以观测为准**。

---

*本文档描述 IB 的"自主行为"机制，全部由真实代码取证（`plan-domain.js` / `scheduler.js` / `model-client.js` / `proactive-interaction-core.js` / `moments.js` / `reply-chain-core.js`），并如实标注"无长时程规划""无内容级 OOC 防火墙"等边界。下一步见 [OFFLINE.md](OFFLINE.md)（规划中）与 [WHY_IB.md](WHY_IB.md)（规划中）。*
