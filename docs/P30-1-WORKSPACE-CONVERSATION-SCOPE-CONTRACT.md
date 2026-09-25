# P30-1 Workspace Conversation Scope Contract
## Contract Design + Freeze Only

阶段性质：**CONTRACT DESIGN + FREEZE ONLY / NO PRODUCTION IMPLEMENTATION / NO CODE CHANGE /
NO QUEUE FILTERING / NO CONSUMER MODIFICATION / NO DB MIGRATION / NO COMMIT**。

本文档**冻结契约**，不含实现。上游：`docs/P30-0-WORKSPACE-CONVERSATION-SCOPE-AUDIT.md`
（PASS — READY FOR CONTRACT FREEZE）。

---

## 1 State

**P30-1 State: PASS — CONTRACT FROZEN**

本阶段未修改任何 production 文件；唯一制品 = 本文档。

**上游事实（P30-0 已实证）**：

| 结论 | 证据 |
|---|---|
| R2 = REAL（跨会话消费） | G1 里 B 产生的条目 → 1:1 C 消费；queue `1→0` |
| R2 是 **destructive**（MISROUTING + LOSS） | 错误消费者取走后，正确会话永远拿不到 |
| actorId **不能**解决它 | 同角色跨会话（G1 的条目进了 B 自己的 1:1）实证 |
| N1 = SAME PRINCIPLE / DIFFERENT CONTRACT | blog 队列无 actor、由用户点击产生 |
| canonical scope 已存在 | `chat-core.conversationIdOf(friendId, threadId)`（`chat-core.js:104-109`） |

**两处措辞更正（审计诚实性）**：

1. 本阶段的队列清单写作 `_wsPendingToolResults` —— 该标识符在仓库中**不存在**（`rg` 计数 0）。
   实名是 **`_ibToolPendingResults`**（`site-operations.js:237`）。本文档按实名冻结。
2. blog 侧有两个队列：`_blogPendingReads`（正文回注）与 `_blogReadFeedback`（申请结果反馈），
   两者同属 §13 的独立契约。

---

## 2 Problem

```
Actor Identity（P29 已冻结）  →  actorId  = WHO produced      ✓
Conversation Scope（缺失）    →  WHERE does this item belong  ✗
```

结果：全局 pending 条目被**任意会话**的下一个注入点消费（且被移除）。
目标是把 WHERE 补进契约与数据形状，使条目只被其所属会话消费，未匹配条目留在队列。

**冻结**：`WHO != WHERE != WHEN`（actor / conversation / turn 三个正交维度，不得互相推导）。

---

## 3 Identity Model

| 术语 | 含义 | 存储/真源 |
|---|---|---|
| `actorId` | **谁产生了这条 workspace 结果** | runtime item 字段（P29-3 冻结，= `cfg.id`） |
| `speakerId` | **谁说了这条消息** | `chatMessages.metadata.speakerId`（P24-M2） |
| `friendId` / `threadId` | **会话归属的两个分量** | runtime item 字段（本阶段新增，additive） |
| `conversationId` | **派生键**（不是存储事实） | 只能由 `chat-core.conversationIdOf(friendId, threadId)` 当场派生 |
| `groupTurnId` | 群回合（turn scope） | P24 runtime-only，不参与会话归属 |
| `activityId` | Activity 来源（context） | 消息 metadata，不参与会话归属 |
| `actor` / `senderName` / `displayName` | 人类可读标签 | display-only |

**禁止**：

* 用 `actor` / `senderName` 推导 scope；
* 用 `friendId` 推导 actor；
* 把 `conversationId` 当作可存储的规范事实（它是派生值）；
* 把 Activity Session / Group Turn 当 Chat Conversation。

---

## 4 Scope Model

**唯一 canonical source**：

```js
// assets/js/chat-core.js:104-109（唯一真源，禁止复制逻辑）
conversationIdOf(friendId, threadId)
// = ('group:' | 'dm:') + friendId  [ + '|' + threadId ]      // CONV_SEP='|'（:88）
```

形状示例（`chat-core.js:88-90` 的前缀常量）：

| 场景 | `(friendId, threadId)` | `conversationIdOf` |
|---|---|---|
| 1:1 主对话 | `('friend_x', null)` | `dm:friend_x` |
| 1:1 话题频道 | `('friend_x', 'thread_t1')` | `dm:friend_x\|thread_t1` |
| 群聊 | `('group_y', null)` | `group:group_y` |
| 角色私信（既有派生） | `('roledm_…', null)` | `dm:roledm_…`（`chat-core.js:96-102` 刻意归入 dm 分支） |

**冻结规则**：

1. `threadId` 为 `null` / `undefined` / `''` 一律等价于"无频道"（`conversationIdOf` 会省略分隔段）；
2. **条目的 scope 存在 ⟺ `friendId` 是非空字符串**（`threadId` 可缺省）；
3. 比较**必须**通过 `conversationIdOf`（不得在本层拼接字符串，制造第二份派生规则）；
4. `conversationIdOf` 是纯函数、确定性（同输入同输出），逆函数 `parseConversationId` 已存在
   （`chat-core.js:113+`），P30-2 可用它做诊断，但**不得**据此新增存储字段。

---

## 5 Item Contract

**冻结的未来形态（additive）**：

```js
// Workspace pending runtime item
{
  actor,            // display-only（不变）
  actorId,          // producer identity（P29-3 不变）
  friendId?,        // conversation owner component（新增，可缺省）
  threadId?,        // conversation channel component（新增，可缺省 = 无频道）
  ...               // 其余字段逐字不变
}
```

| 字段 | 语义 | 约束 |
|---|---|---|
| `actor` | display label | 不得参与任何判定（P29-2 已冻结） |
| `actorId` | canonical producer identity | 语义不变；不得被 scope 影响 |
| `friendId` | 会话 owner 分量 | 非空字符串 ⇒ 条目 **scoped**；缺失 ⇒ unscoped |
| `threadId` | 会话 channel 分量 | 可为 `null`/缺省（= 主对话或群）；非空 ⇒ 话题频道 |

**禁止**：

* 从 `actor` / `senderName` 推导 scope；
* 从 `friendId` 推导 actor；
* rename / delete 既有键；改变 `text`/`content`；改变 queue order / lifecycle / UI display；
* 为"完整率"给 intentionally unscoped 条目强填 scope。

---

## 6 Producer Rules

**归属**：**producer 负责写 scope**（Q1）。理由：只有 producer 当场持有 `ictx`
（`{source, friendId, threadId, …}`）。

| producer 当场拥有 | 必须写入 | 结果 |
|---|---|---|
| `friendId` + `threadId` | 两者都写 | scoped（含频道） |
| 只有 `friendId` | `friendId`，且 `threadId = null` | scoped（主对话/群） |
| 都没有 | 不写 scope | **INTENTIONALLY_UNSCOPED**（§11） |

**禁止**：猜测；fallback 到 `actor`；fallback 到 `senderName`；用"当前 UI 指针"弥补缺失的 ictx。

**P30-2 必须补齐的 producer 面**（P30-0 §9 已定位）：

| 位置 | 现状 | 待补 |
|---|---|---|
| `communication.js:2722`（群）· `:3177`/`:3294`（1:1）· `:4455`（tool continuation） | `ictx` 已带 friendId/threadId | 把两者写进条目（`_execWsOps` 单点） |
| `workspace.js:1052`（`continueTruncatedMsg`） | 未传 `ictx` | 补传（调用方在 1:1 上下文，有 `_targetFriend`/`_targetThread`） |
| `_rCtx`（run 卡片确认路径 → `_wsQueueRunOutput`） | 只有 actor/actorId | 补 friendId/threadId（随 `_execWsOps` 的 ictx 传入） |
| tool 卡片确认路径（`_ibConfirmToolFromCard` → `_ibQueueToolResult`） | 只有 actor/actorId | 同上 |
| `_wsCheckPhantom` 三个调用点 | 已传 actorId | 需同时传 scope（调用点有会话上下文） |
| guard breaker（`site-operations.js:316`） | 无 actor、无 scope | **保持 intentionally unscoped** |

---

## 7 Consumer Rules

**归属**：**consumer 负责验证 scope**（Q2）。理由：消费者当前的 conversation 是最终事实。

消费者必须提供自己的 current scope：

```js
current = { friendId, threadId }        // 群 = (group_*, null)（群 UI 无话题频道）
                                        // 1:1 = (角色 id, activeThreadId)
```

| 条目状态 | 规则 |
|---|---|
| scoped 且 `conversationIdOf(item) === conversationIdOf(current)` | **available ⇒ 可消费** |
| scoped 但 conversation 不同 | **remain（留在队列，不得移除）** |
| unscoped（`friendId` 缺失） | **legacy fallback**（§10：既有 actor/legacy 规则 + 首轮兜底） |

**与 P29-3 的关系（两个正交合取项）**：

```
可消费 ⟺ scope 命中（WHERE）  ∧  actor 命中（WHO，群聊场景的 _gInjMine）
```

`_gInjMine` 的 actor 语义**不变**；scope 作为**附加合取项**加入同一 filter。
1:1 / tool continuation 目前没有 actor filter（take-all）——本契约只要求它们增加 **scope** 过滤；
actor 维度在 1:1 场景由"一个会话只有一个角色"自然成立（R2 的 actor 部分已由 P29-3 闭合）。

**不受影响**：UI 读取提示与 `chat-context-signals` 只读 `.length`/`text`（display/信号），
不属于消费路径；本契约不要求它们改变（若未来改变，仍不得移除条目）。

---

## 8 Queue Semantics

**最高优先级 invariant（destructive consumption rule）**：

> Consumer may remove **only**:
> ① 与自己 scope 匹配的条目；② 通过 legacy fallback 被消费的 intentionally unscoped 条目。
> **Never remove another conversation's scoped item.**

违反该 invariant 即 **MISROUTING + LOSS**（P30-0 §16 已实证）。

其余冻结项：

* 队列仍是 **global runtime queue**（模块态数组，browser-only），本契约不要求改成 per-conversation map；
* 现有 `take / keep` 机制（`_getWsReadInjection(filterFn)` 等的既有形态）正好表达"匹配项移出、非匹配项保留"；
* **禁止** "consume then filter"；**禁止** drop 非匹配项；
* **不得**改变队列 FIFO 顺序（filter 只决定"谁消费"，不重排）；
* 图片类 drain 的 `splice(0)` **不在本契约**（§14）。

---

## 9 Missing Scope

| 情形 | 冻结行为 |
|---|---|
| scoped 条目 + 匹配的 consumer | 消费（并注入） |
| scoped 条目 + 不匹配的 consumer | **KEEP**：留在队列，等待其所属会话 |
| 队列里同时有匹配与非匹配 | 只取匹配项；非匹配项按原顺序保留 |
| 同一条目被多个会话竞争 | **first matching consumer wins**（与今日语义一致，但赢家必须是 owner） |

**禁止**：`consume → filter`（先整体取走再筛），那会把别人的条目从队列里抹掉。

---

## 10 Legacy Policy

* 相关队列全部 **runtime-only**（`files.js:4/6` · `run.js:12` · `site-operations.js:237`），
  刷新即清空 ⇒ **NO migration / NO DB_VER bump**（`DB_VER` 保持 24）。
* "历史条目"只可能存在于**同一次会话运行期间**（新代码上线后旧队列不会残留）：这类条目没有 scope
  ⇒ 走 **legacy behavior**（§11 的 fallback 路径）。
* **禁止**：给历史条目补写 scope；用 `actor` 反推 scope；用"当前会话"强行绑定历史条目。

---

## 11 Intentionally Unscoped

允许无 scope 的条目（冻结）：

| 来源 | 证据 | 处理 |
|---|---|---|
| guard breaker（熔断） | `site-operations.js:316`（作用域内既无 actor 也无会话） | **INTENTIONALLY_UNSCOPED** |
| 用户手动运行脚本 | `run.js:243`（从 ICode UI 触发，`author:'User'`） | 同上（同时是 actor-unattributed） |
| 诊断入口 | `_processWsResponse`（测试/诊断） | 同上（非产品路径） |
| 测试 | 各 focused suite | 同上 |

**语义冻结**：上述条目**保持现有 first-turn fallback**（P29-2/P29-3 已冻结的"无主 ⇒ 本轮首个发言者兜底消费"），
**不得**强制绑定当前 conversation，也**不得**为了 scope 完整率补字段。

---

## 12 Workspace Queue Scope

本契约适用（**Workspace Conversation Scoped Queue**）：

| 队列 | 实名位置 | 内容 |
|---|---|---|
| `_wsPendingReads` | `workspace/files.js:4` | 文件读取结果 |
| `_wsPendingOpFeedback` | `workspace/files.js:6` | 操作失败/截断/改名反馈 |
| `_wsPendingRunOutputs` | `workspace/run.js:12` | 脚本运行输出 |
| **`_ibToolPendingResults`** | `site-operations.js:237` | 工具调用结果（本文档 §1 已更正命名） |

**不属于本契约**（明确排除）：

* P23 delivery queue（`delivery-runtime.js`，已是 conversation-scoped，仅作 precedent）；
* P24 group runtime 状态（`_gGroupTurnStates`、planner、memberTurnId）；
* P25 autonomy / 任何 Action 队列；
* `_ibImageDrain` / `_ibToolDrainImages`（§14）；
* `_blogPendingReads` / `_blogReadFeedback`（§13）；
* UI 队列（TTS 播放、记忆审批弹窗）——非 prompt 可见、非身份/归属路径。

---

## 13 Blog Boundary

**冻结：不直接合并。workspace = conversation scope contract；blog = separate contract。**
分类记为 **SAME PRINCIPLE / DIFFERENT CONTRACT**，理由（三者都不同）：

| 维度 | Workspace | Blog |
|---|---|---|
| producer | 角色在会话内输出 `<ws_*>`（模型产出） | **用户点击「允许」**（`workspace.js:1180-1192`）+ 自动续答 |
| actor | 有 canonical `actorId` | **没有** actor（用户内容） |
| lifetime | 跨 turn 直到被消费 | 一次性（授权后立即续答消费；`_blogPendingReads=[]` at `:1226`） |
| 可复用之处 | — | **字段词汇与"only-own-conversation"原则**（producer 当场已有 `activeFriendId`：`:1182`） |

⇒ blog 的契约（含 threadId 捕获与失败分支）在独立阶段冻结；本契约**不**为它设定行为。

---

## 14 Image Boundary

**R3 继续排除。** `_ibImageDrain` / `_ibToolDrainImages` 缺少 actor **且**缺少 scope，
且消费是 `splice(0)`（take-all）⇒ 归 **Media Attribution / Queue Scope** 阶段处理，
不属 P30（也不得借 P30 顺手改形状）。

> 注：P30-0 已实证图片可跨角色/跨会话进入他人 prompt（`A_requestHasImagePart=true`）；该风险在
> Media 阶段一并解决，本阶段不改变其现状。

---

## 15 P23/P24 Boundary

| 边界 | 冻结 |
|---|---|
| P23 `delivery-runtime` | **只作 precedent**：其"队列按 canonical conversationId 绑定"（`delivery-runtime.js:120-140`）证明形态可行；**Workspace 不迁移到 P23**，本契约也不复用其 runtime |
| `conversationIdOf` | 唯一允许复用的派生入口（`chat-core`） |
| P24 | **零修改**：speaker identity / `groupTurnId` / `memberTurnId` / planner / targeting / recent / SILENT / DEFER / cap 全部保持 |
| Session | **不引入** `sessionId`、不创建 Session Manager、不改 P27 Activity；conversation scope = **chat conversation only** |

---

## 16 Test Contract

只设计，不实现（P30-2 实施时必须全部覆盖）：

| # | 用例 | 断言要点 |
|---|---|---|
| **C1** | G1 里 B 产生条目 → **C 的 1:1** | 不注入 C；条目**仍在队列**（P30-0 现状：会被消费并清空） |
| **C2** | G1 里 B 产生条目 → **G1 归属回合** | B 收到（scoped 命中）；其它成员不受影响（actor 维度仍生效） |
| **C3** | 错误会话先尝试消费 | 条目**保留**；随后正确会话仍能消费（MISROUTING + LOSS 消除） |
| **C4** | 同 actor / 不同 thread（1:1 主对话 vs 话题频道） | 主对话不得消费频道条目，反之亦然（**可表示**：`social.js:1761-1782`） |
| **C5** | legacy 条目（无 scope） | 走 legacy behavior（既有 actor/legacy 规则 + 首轮兜底），不被 drop |
| **C6** | intentionally unscoped（guard breaker / 手动脚本） | 保持 first-turn fallback（与 P29-3 `A10` 同语义） |
| **C7** | actorId 语义 | `test_workspace_actor_identity.js`（49）继续全绿；actor 判定不因 scope 改变 |
| **C8** | `conversationIdOf` 确定性 | 同输入同输出；`('friend_x',null)→'dm:friend_x'`、`('friend_x','t')→'dm:friend_x\|t'`、`('group_y',null)→'group:group_y'`；与 `parseConversationId` 往返一致 |
| **C9** | `DB_VER=24` | 无新 store / 无 migration / 队列仍 runtime-only |
| **C10** | P24 未触碰 | `group-runtime-core.js` 零改动；planner/memberTurnId/targeting/recent 断言 |
| **N1**（独立） | blog 契约 | 由 §13 的独立阶段定义并测试 |

补充不变量断言（建议并入 C3/C6）：

* 非匹配条目的**顺序与数量不变**；
* 消费只发生在匹配项上（可用计数探针：`queue.length` 差值 = 匹配项数）。

---

## 17 Implementation Readiness

**Required Decision Table（本阶段冻结结果）**：

| Question | Decision |
|---|---|
| canonical scope | `chat-core.conversationIdOf(friendId, threadId)`（唯一真源，禁复制） |
| stored fields | `friendId` + `threadId`（**composite existing fields**；不存 `conversationId`） |
| derived identity | `conversationIdOf(item.friendId, item.threadId)` 与 `conversationIdOf(current.friendId, current.threadId)` 比较 |
| producer owner | **producer**（当场写 scope；有三个缺口待补，见 §6） |
| consumer verifier | **consumer**（提供 current scope 并过滤；只消费匹配项） |
| missing scope | 条目缺 `friendId` ⇒ unscoped；consumer 走 legacy fallback |
| non matching item | **KEEP**（留在队列，不得 consume-then-filter，不得 drop） |
| legacy item | runtime-only ⇒ 无 migration；按 legacy behavior 处理；不得反推 scope |
| unscoped item | `INTENTIONALLY_UNSCOPED`（guard breaker / 手动脚本 / 诊断 / 测试）⇒ 保留 first-turn fallback |
| DB migration | **NO**（`DB_VER` 保持 24） |
| P24 change | **NO** |
| P23 change | **NO**（仅作 precedent） |

**P30-2（未来实现）的最小面**：

| 面 | 文件 | 内容 |
|---|---|---|
| producer | `workspace.js`（`_execWsOps` 单点 + `_rCtx`）、`workspace/run.js`（run output）、`site-operations.js`（tool 结果）、`communication.js`（三处 `_wsCheckPhantom` 透传、`continueTruncatedMsg` 调用点） | 条目带 `friendId`/`threadId`；guard breaker 保持无 scope |
| consumer | `communication.js`（群 filter 增 scope 合取项；1:1 与 tool continuation 增 scope filter） | 匹配消费 / 非匹配保留；legacy 与 intentionally unscoped 保持原语义 |
| 兼容 | — | display 文案不变、UI 不变、queue 顺序不变、P29 actor 语义不变、P24/P23/DB 不变 |
| 禁止 | `delivery-runtime.js`、`group-runtime-core.js`、`core.js`（schema）、Memory、MB、任何新 Authority/Manager/Bus/Store | — |

**停止条件**：若实施时发现必须改 P24 identity / memberTurnId / planner / DB schema / 引入 sessionId，
**STOP 并报告**——本契约不授权这些。

---

## Final State

**P30-1 State: PASS — CONTRACT FROZEN**
