# P30-0 Workspace Conversation Scope Audit
## Canonical Conversation Ownership Discovery

阶段性质：**READ-ONLY ARCHITECTURE AUDIT / SCOPE CONTRACT DISCOVERY / REAL DATAFLOW VERIFICATION /
NO PRODUCTION MUTATION / NO SCHEMA CHANGE / NO DB MIGRATION / NO COMMIT**。

本阶段**不改任何 production 文件**（唯一制品 = 本文档）；临时探针写在仓库根并在运行后删除
（`git status` 无残留）。

---

## 1. State

**P30-0 State: PASS — READY FOR CONTRACT FREEZE**

```
canonical scope source : 已存在 —— chat-core.conversationIdOf(friendId, threadId)
producer knows scope   : PARTIAL（4/5 workspace 调用点当场有 friendId+threadId；3 处缺）
consumer knows scope   : YES（群 / 1:1 / tool continuation 都持有 friendId+threadId）
recommended field      : COMPOSITE_EXISTING_FIELDS → friendId + threadId（比较键复用 conversationIdOf）
R2 / N1                : 均**真实可复现**，且**destructive**（错误消费者把条目从队列里取走）
DB migration           : NO        P24 change: NO        P23 change: NO
```

P30-1 需要**冻结**（不是发明）的三项：① scope 字段形状（§25/§29）；② unscoped 条目规则（§21）；
③ N1 是否与本契约共用（§27）。

---

## 2. Problem Definition

P29-C 已实证：`actorId = WHO produced` 正确，但 `WHERE does this item belong` **完全缺失**。

```
Role B（Group G1 语境）产生 workspace runtime item
        ↓  { actor:'希儿', actorId:'friend_p300_b', text:'…' }   ← 无任何会话归属
module-global queue（_wsPendingOpFeedback 等）
        ↓  take-all / splice
Role C 的 1:1 conversation 消费该 item → 进入 C 的 prompt（且队列被清空）
```

本阶段回答：IB 的 canonical conversation identity 是什么、能否直接复用、producer/consumer 是否知道它。

---

## 3. Identity vs Scope

```
actorId                 = WHO produced
speakerId               = WHO spoke
thread/conversation     = WHERE this item belongs     ← 本阶段维度
groupTurnId             = which group user-turn / runtime turn（turn scope）
activityId              = which Activity runtime（context 来源，不是会话归属）
friendId                = 会话目标键（1:1 = 角色 id；群 = group_*）
conversationId          = friendId + threadId 的**派生**规范键（唯一真源 = chat-core）
```

**冻结**：`actorId` 不得用来表达 WHERE（§12 的 S3 案例已实证二者不等价）。

---

## 4. Existing Conversation Model

| 面 | 事实 | 证据 |
|---|---|---|
| canonical 会话键 | `conversationIdOf(friendId, threadId)` = `('dm:'\|'group:') + friendId [+ '\|' + threadId]`；逆函数 `parseConversationId`；`conversationIdOfMessage(message)` | `assets/js/chat-core.js:92-139`、`:264-266` |
| 1:1 如何唯一定位 | `(friendId = 角色 id, threadId = null)` = 主对话；有 `threadId` = 话题频道 | `assets/js/social.js:680`（`activeThreadId` 语义）、`communication.js:2907` |
| 同角色能否多 thread | **能**（`chatThreads` store；每角色可建多个话题频道） | `social.js:1761-1782`（`for(const a of apiConfigs)` + `allThreads.filter(t=>t.friendId===a.id)` + 「新建话题频道」按钮）、`social.js:2504/2520` |
| Group 如何唯一定位 | `friendId = group_*`（群 UI **不**提供话题频道 ⇒ threadId 恒 null） | `social.js:1784`（groups 单独渲染）、`communication.js:2148`（`_targetThread=…activeThreadId`） |
| Group 内不同 turn | `groupTurnId`（每用户群回合一个，runtime-only） | `group-runtime-core.js:92-97`、`communication.js:2201` |
| chatMessages 如何绑定会话 | 消息行带 `friendId`（+ 可选 `threadId`）；读侧按 `(friendId, threadId)` 过滤 | `communication.js:2863`（1:1 写 threadId）、`:2907`（读侧过滤）、`social.js:2546`（thread 读） |
| UI 当前会话选择 | `activeFriendId` + `activeThreadId`（模块态 UI 指针） | `social.js:680`、`communication.js:2148` |
| message writer 写哪些 scope 键 | `friendId` 必写；`threadId` 仅在话题频道（1:1）写；群 assistant 消息经 Sequence 带 `threadId: _targetThread\|\|''` | `communication.js:2863`、`:3223`、`:2736` |
| history loader 用哪些 scope 键 | `(friendId, threadId)` 二元组 | `communication.js:2907`、`social.js:2546` |

**结论**：IB **已经存在** canonical conversation identity（`conversationIdOf`），派生规则唯一属于 `chat-core`。

---

## 5. Scope Candidate Matrix

| Candidate | Meaning | 1:1 | Group | Multi-thread | Stable | Available at producer | Available at consumer | Suitable |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `friendId` | 会话目标（1:1=角色 id；群=`group_*`） | ✔ | ✔ | ✘（跨 thread 相同） | ✔ | ✔（4/5 调用点） | ✔ | **单独不够** |
| `threadId` | 话题频道 id（主对话为 null） | ✔（可为 null） | ✘（群 UI 无 thread） | ✔ | ✔ | ✔（随 ictx） | ✔ | **单独不够** |
| group id | `group_*` = 群的 friendId | n/a | ✔ | n/a | ✔ | ✔ | ✔ | 与 friendId 同物 |
| `groupTurnId` | 群回合 | n/a | ✔（turn） | n/a | 仅本轮 | ✔ | ✔ | ✘（turn scope，§8） |
| `activityId` | Activity 来源 | 可选 | 可选 | — | 活动期 | ✔（1:1 路径） | ✔ | ✘（context，非归属，§23） |
| **`conversationId`** | `conversationIdOf(friendId, threadId)` 派生 | ✔ | ✔ | ✔ | ✔ | 可当场派生（chat-core） | 可当场派生 | **✔（比较键）** |
| composite `(friendId, threadId)` | 上面两者的原始字段 | ✔ | ✔ | ✔ | ✔ | ✔（4/5） | ✔ | **✔（推荐存储形状）** |

---

## 6. threadId

| 问题 | 回答 | 证据 |
|---|---|---|
| Q1 `threadId` 是 canonical conversation identity 吗 | **不是单独一个**；它是会话身份的**分量**（唯一真源是 `conversationIdOf(friendId, threadId)`） | `chat-core.js:104` |
| Q2 所有 1:1 消息都有 threadId 吗 | **否**：主对话的 `threadId` 为 `null`/缺失（`if(_targetThread)userMsg.threadId=…`） | `communication.js:2863`、`social.js:680` |
| Q3 Group 消息有 threadId 吗 | **UI 不提供**群话题频道 ⇒ 群会话 `threadId` 恒空；管线允许（`_targetThread` 来自全局 `activeThreadId`），但群 UI 无法设它 | `social.js:1761-1782`（threads 只在 apiConfig 行下渲染）、`communication.js:2148/2736` |
| Q4 legacy 消息缺 threadId | 视为**主对话**（`filter(m=>_targetThread?m.threadId===_targetThread:!m.threadId)`） | `communication.js:2907` |
| Q5 同角色能否多 threadId | **能**（话题频道；`chatThreads` byFriend） | `social.js:2504/2520` |
| Q6 workspace producer 当场可得吗 | **可得（4/5）**：`ictx.threadId` 由 `_execWsOps` 调用方传入 | `communication.js:2722/3177/3294/4455` |
| Q7 workspace consumer 当场可得吗 | **可得**：群/1:1 都有 `_targetThread`；tool continuation 有 `o.threadId` | `communication.js:1849`（群 builder 作用域内 `group`/`_gParticipants` 同级）、`1724`、`4450` |

⇒ **threadId 单独不能覆盖 Group，也不能区分 1:1 主对话与其它角色** ⇒ 必须与 friendId 组成 composite。

---

## 7. friendId

| 问题 | 回答 | 证据 |
|---|---|---|
| Q8 `friendId` 语义 | **mixed（按既有契约）**：1:1 时 = 角色 id（会话目标即角色），群时 = `group_*`（会话目标即群）；它始终是"会话目标键"，**不是** thread 身份 | `chat-core.js:92`（`isGroupFriendId`）、`communication.js:2132`（`_targetFriend.startsWith('group_')`） |
| Q9 1:1 中等于 role id 吗 | 是（`friendId === apiConfigs.id`） | `communication.js:2779`（`apiConfigs.find(a=>a.id===_targetFriend)`） |
| Q10 Group 中是 `group_*` 吗 | 是 | `communication.js:2132`、`social.js:2060`（`id:'group_'+…`） |
| Q11 同一 friendId 允许多 thread 吗 | **允许**（话题频道同属该 friendId） | `social.js:1762/2504` |

⇒ **friendId 单独不能作为 conversation scope**（同角色多 thread 会互相串）。

---

## 8. groupTurnId

| 问题 | 回答 | 证据 |
|---|---|---|
| Q12 生命周期 | **runtime-only 的单轮**：由触发本轮的用户消息 id 派生；`_gGroupTurnStates` 在回合结束时注销 | `group-runtime-core.js:92`、`communication.js:2201/2796`（`_ibGroupTurnEnd`） |
| Q13 每个用户 group turn 都变吗 | 是（不同 user message id ⇒ 不同 `groupTurnId`） | `group-runtime-core.js:86-97` |
| Q14 能否用于长期 Workspace item ownership | **不能**：workspace 结果在"下一条消息"注入（跨 turn），而 `groupTurnId` 每轮变；且它属 P24 runtime | UI/指令文案「将在下一条消息注入」`workspace.js:1239`、`site-operations.js:62` |

⇒ **排除**（turn scope ≠ conversation scope）。P24 未改。

---

## 9. Workspace Producers

| producer | actorId | friendId | threadId | groupId | groupTurnId | other scope |
|---|---:|---:|---:|---:|---:|---|
| `communication.js:2722`（群聊成员 `<ws_*>`） | ✔ | ✔ `_targetFriend` | ✔ `_targetThread` | ✔（=friendId） | 可得（`_gTurn`） | source/`_ibTurn` |
| `communication.js:3177`（1:1 流式） | ✔ | ✔ | ✔ | n/a | n/a | `userMessageId`/`_ibTurn` |
| `communication.js:3294`（1:1 非流式） | ✔ | ✔ | ✔ | n/a | n/a | 同上 |
| `communication.js:4455`（tool continuation） | ✔ | ✔ `o.friendId` | ✔ `o.threadId` | 可能 | 可能 | `_ibTurn` |
| `workspace.js:1052`（`continueTruncatedMsg` 续写增量） | ✔ | **✘ 未传 ictx** | **✘** | ✘ | ✘ | — |
| `workspace.js:657`（`_processWsResponse`，**测试/诊断专用**） | ✔ | ✘ | ✘ | ✘ | ✘ | — |
| run 卡片确认路径（`_wsConfirmRunFromCard` → `_wsQueueRunOutput`） | ✔（`_rCtx.actorId`，P29-3） | **✘** | **✘** | ✘ | ✘ | — |
| tool 卡片确认路径（`_ibConfirmToolFromCard`） | ✔（`ctx.actorId`） | ✘ | ✘ | ✘ | ✘ | — |
| `_wsCheckPhantom`（群/1:1 三处） | ✔（P29-3 传入 `cfg.id`） | 可得（调用点有 `_targetFriend`） | 可得 | 可得 | — | — |
| N1 blog `_brAllow`（`workspace.js:1180-1192`） | ✘（用户内容，无需 actor） | **✔ 当场有 `activeFriendId`**（`workspace.js:1182`，同处还用它做发送中守卫） | ✘（未捕获 `activeThreadId`） | — | — | `postId` |

**丢失位置**：`_execWsOps` 收到 `ictx`（含 friendId/threadId）后，**只把 actor 写进队列条目**，
没有把 WHERE 写进去（P30-1 的最小改动点）；`_rCtx`（run 卡片）与 `_brAllow` 也各缺一段。

---

## 10. Workspace Consumers

| consumer | current actor | current conversation | current thread | filter today | take-all? |
|---|---|---|---|---|---|
| 群聊注入 `communication.js:1849` | `cfg.id`（canonical） | `_targetFriend`（群 id） | `_targetThread` | 仅 `_gInjMine`（actor） | 否（filter 有 take/keep） |
| 1:1 context `communication.js:1724` | — | `_targetFriend` | `_targetThread` | **无** | **是** |
| tool continuation `communication.js:4450` | — | `o.friendId` | `o.threadId` | **无** | **是** |
| UI 读取提示 `communication.js:2772/2784/3213/3419` | — | 当前会话 | 当前会话 | 只读 `.length` | 否 |
| 图片注入 `communication.js:2536/2950/4425` | — | 同上 | 同上 | **无** | **是（splice(0)）** |
| 标题信号 `chat-context-signals.js:42-44/151-153` | — | 无 | 无 | 只读 length/text | 否 |

**结论**：**消费者全部当场知道自己的 WHERE**（`_targetFriend`/`_targetThread` 或 `o.friendId`/`o.threadId`）——
所以 P30-1 的修复面只需"条目带上 WHERE + 消费者按 WHERE 过滤"，不需要新的会话查找。

---

## 11. R2 Reproduction

真实浏览器 + 真实 producer/consumer（探针，已删除）：

```
producer scope : Group G1 语境（ictx {friendId:'group_1700000006001', threadId:''}）
item shape     : { actor:'希儿', actorId:'friend_p300_b', text:'P300-R2' }   ← 无会话字段
consumer scope : 1:1 conversation with Role C（friendId:'friend_p300_c'）
queue before   : 1
R2.C_saw       : true      ← C 的 prompt 收到了 B 在 G1 产生的结果
R2.queueAfter  : 0         ← 条目被取走（destructive）
```

---

## 12. Same Actor / Different Conversation

**IB 支持同角色多会话**（1:1 主对话 + N 个话题频道，§4/§6 Q5）⇒ 该案例**可表示**，并且已实证：

```
producer scope : Group G1（由 Role B 产生）
consumer scope : Role B 自己的 1:1 conversation（actorId 相同！）
S3.B_1to1_saw_G1_item : true
S3.queueAfter         : 0
```

⇒ **结论（P30 的关键证明）**：`actorId(X) === actorId(Y)` 而会话不同时，**actorId 无法阻止泄漏**。
这就是"actorId 不能解决 R2"的直接证据。**未使用 NOT CURRENTLY REPRESENTABLE**——它是可表示的。

---

## 13. Group-to-Group

角色可同属多个群（`groups` store 独立；B 同时是 G1/G2 成员）。实证：

```
producer scope : G1（Role B）
consumer scope : G2（Role B 也是成员）
G2.B_saw_G1_item_in_G2 : true
G2.queueAfter          : 0
```

⇒ **真实存在**（同 actorId、不同 group 会话）。

---

## 14. 1:1-to-Group

反方向同样成立：

```
producer scope : Role B 的 1:1 conversation
consumer scope : Group G1（B 是成员）
T2G.B_saw_1to1_item_in_group : true
T2G.queueAfter               : 0
```

区分两件事：

* **actor attribution 正确**（条目确实属于 B，`actorId` 无误）；
* **conversation ownership 错误**（B 在 1:1 里请求的文件读取结果，被注入到群聊回合）。

---

## 15. Queue Semantics

| 队列 | 类别 | drain 时机 | drain 是否破坏性 | first consumer wins |
|---|---|---|---|---|
| `_wsPendingReads`（`files.js:4`） | **GLOBAL MODULE QUEUE** | 每个注入点（群/1:1/续轮） | **是**（`_wsPendingReads=keep`，匹配项被移出） | **是** |
| `_wsPendingOpFeedback`（`files.js:6`） | **GLOBAL MODULE QUEUE** | 同上 | **是** | **是** |
| `_wsPendingRunOutputs`（`run.js:12`） | **GLOBAL MODULE QUEUE** | 同上 | **是** | **是** |
| `_ibToolPendingResults`（`site-operations.js:237`） | **GLOBAL MODULE QUEUE** | 同上 | **是** | **是** |
| `_ibImageDrain` / `_ibToolDrainImages`（`site-operations.js:238/239`） | **GLOBAL MODULE QUEUE** | 图片注入点 | **是**（`splice(0)`） | **是** |
| `_blogPendingReads` / `_blogReadFeedback`（`workspace.js:1095/1096`） | **GLOBAL MODULE QUEUE** | `_getBlogReadInjection()`（1:1/续轮） | **是**（`_blogPendingReads=[]`） | **是** |
| P23 delivery queue（`delivery-runtime.js:140`） | **CONVERSATION-SCOPED**（`conversationId → queue`） | 交付期 | 按会话 | 按会话 |

⇒ 工作区/博客/图片队列全是 GLOBAL 且 first-consumer-wins（**这正是 R2/N1/R3 的机制**）。

---

## 16. Destructive Consumption

| 问题 | 回答 | 证据 |
|---|---|---|
| Q15 错误 consumer 是否会从 queue 删除 item | **是**（`forEach` 拆 `take/keep` 后 `_wsPending* = keep`；图片是 `splice(0)`） | `workspace.js:667-669/723-725`、`run.js:208-210`、`site-operations.js:435-437`、`communication.js:2536` |
| Q16 正确 conversation 后续是否永远拿不到 | **是**（条目已被取走，队列里不复存在） | 探针五例 `queueAfter = 0` |

⇒ 分类 **MISROUTING + LOSS**（不是单纯 visibility）。

---

## 17. N1 Blog Pending Reads

| 问题 | 回答 | 证据 |
|---|---|---|
| Q17 module-global？ | **是** | `workspace.js:1095` |
| Q18 有 actor identity？ | **没有**（条目只有 `{title,content,range,total}`） | `workspace.js:1192` |
| Q19 有 conversation scope？ | **没有**（但 producer 当场知道 `activeFriendId`） | `workspace.js:1182`（`var _tf=activeFriendId`）、`:1192`（push 未带） |
| Q20 destructive consume？ | **是** | `workspace.js:1226`（`_blogPendingReads=[]`） |
| Q21 能否跨 conversation 泄漏？ | **能**（实证：C 的 1:1 prompt 收到 `P300-BLOG-CONTENT`，队列归零） | 探针 N1 |
| Q22 与 Workspace R2 是否同一 scope contract？ | **同一原则、不同契约**（见 §27） | — |

---

## 18. Other Pending Queues

| 队列 | 分类 | 依据 |
|---|---|---|
| `_wsPendingReads` / `_wsPendingOpFeedback` / `_wsPendingRunOutputs` / `_ibToolPendingResults` | **SCOPE_RISK**（R2） | 全局 + 破坏性 + 消费者 take-all/仅按 actor 过滤 |
| `_ibImageDrain` / `_ibToolDrainImages` | **SCOPE_RISK**（R3，另见 P29-C） | 全局 + 无 actor + `splice(0)` |
| `_blogPendingReads` / `_blogReadFeedback` | **SCOPE_RISK**（N1） | 全局 + 无 actor/scope + 破坏性 |
| `_ibTtsQueue`（`bridge.js:731`） | **GLOBAL_BUT_INTENTIONAL** | 播放队列，按点击顺序播；非 prompt 可见、非身份 |
| `_memoryApprovalQueue`（`auto-memory.js:198`） | **GLOBAL_BUT_INTENTIONAL** | 用户审批 UI；写入按捕获的 cfg 校验 `friendId` |
| P23 delivery queue | **CONVERSATION_SCOPED** | `delivery-runtime.js:140` |
| `_chatSendingFor` / `_gGroupTurnStates` | **ACTOR/CONVERSATION keyed**（send 锁与回合态按 friendId） | `communication.js:2364/4684`（P29-0 前已存在） |

（本轮只列真实 semantic path；UI 队列不计入 identity/scope bug。）

---

## 19. Scope vs Turn

| 维度 | 寿命 | 用于 |
|---|---|---|
| Conversation scope | 会话/话题频道寿命 | **workspace/blog/image 结果的正确归属** |
| Turn scope | 一次用户/模型回合 | `_ibTurn`（预算/工具周期）、`groupTurnId` |
| Group turn scope | 一次群回合 | P24 参与与身份 |

**Workspace 结果该属于谁？** 证据链：

1. 结果在**模型某一轮的 `<ws_*>` 请求**之后产生（`_execWsOps` 在当轮成员/角色上下文中被调用）；
2. 注入时机是**下一条消息**（用户可见文案：`workspace.js:1239`「将在下一条消息注入给 AI」；
   模型侧指令：`site-operations.js:62`「内容会在用户下一条消息时注入给你」）；
3. 跨 turn 存活（可以被下一轮用），因此**不是** turn-scoped；
4. 它是对**该会话**里某个角色请求的回执 ⇒ 自然属于**该会话**。

⇒ **Conversation scope**（不是 turn、不是 actor、不是 activity）。

---

## 20. Workspace Item Lifetime

| 问题 | 回答 |
|---|---|
| Q23 设计上是哪种 | **current conversation until consumed**（"下一条消息"= 该会话的下一条消息；可跨 turn 直到被消费） |
| Q24 当前行为与预期是否一致 | **不一致**：实现是 `global next consumer`（任意会话的下一次注入点都会消费） |
| 产品契约是否明确 | **UI 文案与模型指令明确写了"下一条消息"**（`workspace.js:1239`、`site-operations.js:62`、`run.js:9`、`files.js:220`），但**没有**任何字段/过滤实现它 ⇒ 契约缺失（不是产品意图不明） |

⇒ 结论：**意图有证据，实现缺字段** ⇒ 属于"契约冻结待办"，不是产品决策争议（见 §32）。

---

## 21. Legacy / Unscoped Items

| 问题 | 回答 |
|---|---|
| 是否需要 legacy migration | **不需要**：所有相关队列 runtime-only（§28），刷新即清空；不存在持久化 scope 数据 |
| scope 缺失 item 应如何处置 | **本阶段不决定**；仓库已有可复用语义：无主/无归属条目目前走"首轮兜底消费"（P29-2/P29-3 冻结），且 §22 的 intentionally-unscoped 条目必须保留该行为 |
| 候选（供 P30-1 冻结） | ① 保留（未匹配则留在队列，允许后继同会话消费）；② 按"无 scope = 仅当前会话可消费"；③ drop（**不推荐**：会丢用户手动脚本结果） |

---

## 22. Intentionally Unscoped Items

| 条目 | 为什么没有 scope | 分类 |
|---|---|---|
| guard 熔断条目（`site-operations.js:316`） | 该作用域既无 actor 也无会话（只有 `op` 与 guard 结果） | **INTENTIONALLY_UNSCOPED**（P29-C 已冻结为 intentionally unattributed） |
| 用户手动运行脚本（`run.js:243` `author:'User'`，从 ICode UI 触发） | 不是从某个会话发起 | **INTENTIONALLY_UNSCOPED** |
| 测试/诊断入口（`_processWsResponse`、`continueTruncatedMsg` 无 ictx 的路径） | 非产品路径 | **INTENTIONALLY_UNSCOPED（非产品）** |
| 后台诊断/系统告警 | 无会话 | 无（本轮未发现其它） |

⇒ **不得**为了 scope 完整率强行绑定；P30-1 必须显式保留它们的既有兜底。

---

## 23. Manual Script Semantics

| 问题 | 回答 |
|---|---|
| 用户手动运行脚本产生的条目 | **同时是** actor-unattributed（`author:'User'`，无角色）**和** conversation-unscoped（从 ICode UI 触发，非某会话） |
| 未来加 scope 契约时 | **不得**改变该行为（§21/§22 冻结的"无主 ⇒ 首轮兜底"） |

---

## 24. Activity Boundary

| 问题 | 回答 | 证据 |
|---|---|---|
| Workspace 是否可能在 Cinema/Coread/Activity 上下文产生结果 | 会：这些 app 通过**角色的 1:1 会话**发消息，模型在该回合里可能输出 `<ws_*>` | `activity-runtime.js:9/14`（会话 + `metadata.activityId`）、`communication.js:2838-2861` |
| `activityId` 是额外 context 还是会话 owner | **额外 context**：代码注释明确"activityId = 本轮活动来源，threadId = 对话归属，**两个独立语义**" | `communication.js:2832-2837`、`:2861`（写 `metadata.activityId`，不改 threadId） |
| 是否可当 Conversation Scope | **不可以**（P27/P28 冻结；Activity Session ≠ Chat Conversation） | 同上 |

---

## 25. Candidate Contract Shapes

只审计、不冻结。基于仓库既有语义，**最小数据字段**：

```js
// workspace/blog/image pending runtime item（未来候选；不新增 manager/registry）
{ actor: '希儿', actorId: 'friend_x', friendId: 'group_y' | 'friend_z', threadId: null | 'thread_t', … }
```

比较键：`chat-core.conversationIdOf(friendId, threadId)`（**不**在条目里另存 conversationId，
避免第二份派生事实；需要时当场派生）。

> 备选（若 P30-1 判定更合适）：条目只存 `conversationId` 一个派生字段。二者都能表达 WHERE；
> 本审计按 §29 的"复用既有字段/词汇"原则推荐 composite。

---

## 26. Consumer Filtering

| 方案 | 说明 | 评估 |
|---|---|---|
| **A. item 带 scope + consumer 过滤** | 沿用现有 `filterFn` 的 take/keep 机制（`_getWs*Injection(filterFn)` 已经支持保留未匹配项） | **最小改动**：把 `_gInjMine` 的 filter 扩展为"actor ∧ conversation"，并在 1:1/续轮补上 filter |
| B. per-conversation queues | 每次消费按当前会话取子队列 | 需要重构模块态数组为 map；改动更大 |
| C. queue key = scope | 与 P23 delivery runtime 同构（`queues[conversationId]`） | 概念最干净，但把 4-6 个全局数组改造成 map = 更大重构 |
| D. 其它既有模式 | P23 `delivery-runtime.js:140`（conversationId→queue）+ `_ibConvIsActive(friendId,threadId)` | 作为**先例**证明 C 可行；但 P30 不必一步到位 |

**必须满足**（§31 invariant）：non-matching item **留在队列**（现有 take/keep 已具备该性质；
图片 drain 的 `splice(0)` 必须改成分区）。

---

## 27. R2/N1 Relationship

**答案：SAME_PRINCIPLE_DIFFERENT_CONTRACT。**

| 维度 | R2（workspace 4 队列） | N1（blog 2 队列） |
|---|---|---|
| 共同原则 | 全局 pending runtime 条目必须带 WHERE；消费者只消费自己会话的条目；未匹配项保留 | 同 |
| 条目身份 | actor（canonical，P29-3）+ 需补 scope | **无 actor**（用户授权内容） |
| 产生方式 | 角色在会话内输出 `<ws_*>` | **用户点击"允许"**（`_brAllow`）+ 自动续答 |
| legacy/unscoped 规则 | 无主条目保持首轮兜底（P29 冻结） | 用户授权即意味着"该会话立即消费"（`_brAllow` 之后紧接着自动发一轮） |
| 契约归属 | Workspace 队列契约 | Blog 阅读回执契约（同样只需 friendId/threadId 两个既有字段） |

⇒ 可以**共用字段词汇与过滤原则**，但**不应**强行合并成一个契约对象（producer 语义不同）。

---

## 28. Persistence / DB

| 面 | 结论 | 证据 |
|---|---|---|
| 所有相关队列是否 runtime-only | **是** | `files.js:4/6` · `run.js:12` · `site-operations.js:237-239` · `workspace.js:1095/1096` 全是模块态数组；全仓库无 `dbPut`/`localStorage` 写它们 |
| 未来修复是否需要 DB migration / DB_VER bump | **不需要** | 同上 |
| `DB_VER` | **24**（保持不变） | `core.js:3` |

**没有发现 persisted queue**（唯一 persisted 的近似物是 `projectFiles.lastModifiedBy` = R4，属文件溯源，不在本阶段范围）。

---

## 29. Cross-runtime Boundary

| 队列 | 运行位置 | 证据 |
|---|---|---|
| Workspace 4 队列 + blog 2 队列 + image 2 队列 | **仅 Browser runtime**（模块态；live getter 只暴露给页面诊断） | `files.js:1276/1277` · `run.js:276` · `site-operations.js:478/480` · `workspace.js:1518` |
| Home Node / Node companion / Mobile | **不参与**（Home Node 只接管 chatMessages/memories/understandings/moments） | `home-node-bootstrap.js:163-165` |

⇒ **不需要**设计 Home Node scope protocol / companion scope protocol / Event Bus。

---

## 30. Severity

**R2 = MEDIUM**（维持 P29-C 判定），理由：

| 因子 | 评估 |
|---|---|
| cross-conversation prompt contamination | **有**（B 在 G1 的读取结果进入 C 的 1:1 或 B 的另一会话） |
| destructive consumption | **有**（错误消费者取走后，正确会话永远拿不到：MISROUTING + LOSS） |
| 正确 owner 丢失 item | **有**（同一机制） |
| tool continuation contamination | **有**（`:4450` 同样 take-all） |
| user-visible wrong context | **有**（模型可能引用/复述另一个会话的文件内容） |
| 为什么不判 HIGH | **无 canonical mutation**、**无 permission bypass**、单用户产品 ⇒ 不存在跨用户边界穿越；触发需要"同浏览器内存在第二个会话/角色" |
| 为什么不判 LOW | 结果内容可能包含**文件正文**（`ws_read` 注入整段文本），且是破坏性丢失，不只是显示问题 |

---

## 31. Test Plan

未来 implementation（P30-1 之后）至少规划：

| # | 用例 | 现状证据 |
|---|---|---|
| S1 | group B → unrelated 1:1 C **must not** consume | 已实证当前会 consume（§11） |
| S2 | 正确会话稍后仍能收到该 item（未被别人吃掉） | 与 S1 同一 probe 的 queue 断言 |
| S3 | same actor / different conversation（B 的 G1 条目不得进 B 的 1:1） | **可表示且已实证**（§12） |
| S4 | group G1 → group G2（同角色跨群） | **可表示且已实证**（§13） |
| S5 | 1:1 → group | **可表示且已实证**（§14） |
| S6 | non-matching item 留在队列（take/keep 语义） | 现有 filter 机制已具备（`workspace.js:667-669`） |
| S7 | intentionally unscoped 兜底保持（guard breaker / 手动脚本） | P29-3 `A10` |
| S8 | actorId 语义不变（P29-3 suite 继续全绿） | `test_workspace_actor_identity.js` 49 PASS |
| S9 | P24 冻结（planner/memberTurnId/targeting/recent） | `test_group_turn_identity.js` / P24 守卫 |
| S10 | `DB_VER=24` + 无新 store | `core.js:3` |
| N1-1 | blog：会话 A 授权的内容不得进入会话 B 的 prompt | 已实证当前会泄漏（§17） |

---

## 32. Implementation Readiness

```
## P30 Workspace Conversation Scope Readiness

Status:
READY_FOR_CONTRACT_FREEZE

Canonical scope source:
chat-core.conversationIdOf(friendId, threadId)（唯一真源；含 parseConversationId 逆函数与
conversationIdOfMessage）；P23 delivery-runtime 已是"按 conversationId 建队列"的生产先例
（delivery-runtime.js:120-140）。

Producer knows scope:
PARTIAL —— workspace 4/5 调用点当场有 friendId+threadId（ictx）；
缺 3 处：continueTruncatedMsg（workspace.js:1052）、run 卡片 ctx（_rCtx）、
blog `_brAllow`（有 friendId、缺 threadId）。

Consumer knows scope:
YES —— 群 `_targetFriend`/`_targetThread`、1:1 同、tool continuation `o.friendId`/`o.threadId`。

Recommended field:
COMPOSITE_EXISTING_FIELDS = friendId + threadId（比较键用 conversationIdOf 当场派生；
不新增第三份派生事实、不发明新字段名）。

Workspace R2:
真实可复现（5/5 场景含同角色跨会话）且 destructive；修复 = 条目带 (friendId,threadId)
+ 全部注入点按会话过滤（未匹配项保留）。

Blog N1:
同原则、不同契约；producer 当场知道 friendId（workspace.js:1182），缺 threadId；
修复可复用同一字段词汇。

Legacy/unscoped rule:
队列全 runtime-only ⇒ 无 migration。未匹配项**必须保留**（take/keep）；
intentionally unscoped（guard breaker / 手动脚本 / 测试入口）**保持既有首轮兜底**，
不得为了完整率强绑 scope。（候选规则需在 P30-1 显式冻结）

DB migration: NO
P24 change:   NO
P23 change:   NO
```

---

## 33. Next Stage Recommendation

1. **P30-1 · Conversation Scope Contract Freeze**（下一步，只冻结不实现）：
   记录三件事 —— ① 字段形状 `(friendId, threadId)` 与比较键 `conversationIdOf`；
   ② 消费规则（only-own-conversation + 未匹配保留）；③ unscoped/intentional 规则；
   并给出 R2/N1 的分别适用范围。
2. **P30-2 · Workspace Conversation Scope Implementation**：改 producer（补 scope 到条目与
   `_rCtx`/blog producer）+ 4 个注入点过滤（含图片分区 drain）。
3. **媒体（R3）** 与 **文件溯源（R4）** 仍走各自独立阶段（P29-C 已指定名称）。
4. **不做**：ConversationManager / ScopeRegistry / 新 store / Event Bus / P24 改动。

---

## 34. Worktree

| 项 | 结果 |
|---|---|
| 本阶段 production mutation | **ZERO**（未修改任何 production 文件） |
| 新增制品 | `docs/P30-0-WORKSPACE-CONVERSATION-SCOPE-AUDIT.md`（本文档） |
| 临时探针 | `tmp_p300_probe.js`（仓库根，运行后删除；`git status` 无残留） |
| git 操作 | 未使用 `checkout --` / `restore` / `reset --hard` / `clean` / stash；未 stage、未 commit |
| 既有工作树 | 仍含 P11–P29 多批未提交改动（未触碰） |

---

## 附 · Required Final Questions（Q1–Q30）

1. **IB 当前 canonical conversation identity 是什么？** `chat-core.conversationIdOf(friendId, threadId)`（派生键，含逆函数）。
2. **threadId 是否足够？** 不够（主对话/群为 null；同角色多频道会串）。
3. **friendId 是否足够？** 不够（同角色多话题频道共用同一 friendId）。
4. **groupTurnId 是否只是 turn identity？** 是，且每轮变 ⇒ 不能作 workspace ownership。
5. **同一个 actor 是否能存在多个 conversation/thread？** 能（1:1 主对话 + N 话题频道；并已实证 S3）。
6. **Workspace producer 当场是否知道 scope？** PARTIAL（4/5 知道；3 处缺失，见 §9）。
7. **Workspace consumer 当场是否知道 scope？** YES。
8. **R2 是否仍可复现？** 是（§11，且 §12/§13/§14 三个方向都成立）。
9. **错误 consumer 是否 destructive consume？** 是（take/keep 或 splice(0)，first consumer wins）。
10. **正确 owner 是否因此丢失 item？** 是（queueAfter=0）。
11. **actorId 为什么不能解决 R2？** S3：同一角色两个会话 actorId 相同，仍会跨会话注入。
12. **最小 scope 字段是什么？** composite `(friendId, threadId)`。
13. **该字段仓库是否已存在？** 已存在（消息行已带这两个字段；chat-core 已定义派生与逆函数）。
14. **是否需要新 conversation identity contract？** 不需要（复用 chat-core 既有派生；P23 已有先例）。
15. **是否需要 ConversationManager？** 不需要。
16. **是否需要 DB migration？** 不需要（队列 runtime-only）。
17. **是否需要 P24 change？** 不需要。
18. **是否需要 P23 change？** 不需要（P23 队列已是会话隔离的正确形态，只作先例）。
19. **N1 与 R2 是否同一 scope contract？** 同原则、不同契约（§27）。
20. **R3 image drain 是否继续排除？** 是（本阶段仍排除；由 Media Attribution / Queue Scope 处理）。
21. **manual script / guard breaker 应如何处理？** 保持 intentionally unscoped + 既有首轮兜底（不得强绑）。
22. **是否存在 intentionally unscoped item？** 存在（guard breaker / 用户手动脚本 / 测试入口）。
23. **是否发现其它 global pending queue scope risk？** 有：`_blogPendingReads`/`_blogReadFeedback`（N1）与 `_ibImageDrain`/`_ibToolDrainImages`（R3）；P23/TTS/审批队列不是 risk。
24. **R2 严重度是否仍为 Medium？** 是（含破坏性丢失与文件正文外泄，但无 canonical mutation / 无 permission bypass / 单用户）。
25. **下一阶段应是 contract freeze 还是 implementation？** 先 **P30-1 contract freeze**，再 P30-2 implementation。
26. **推荐 scope field 名是什么？** `friendId` + `threadId`（不为派生键另存 `conversationId` 字段）。
27. **nonmatching item 应如何保留？** 留在原队列（take/keep），仅匹配项被消费；禁止"过滤后仍 splice 掉"。
28. **scope filtering 是否会改变 queue ordering？** 不会（保持既有 FIFO 顺序；只改变"谁消费"）。
29. **P30 是否可以保持 runtime-only？** 可以（零持久化、零 schema）。
30. **P30-0 是否 READY FOR CONTRACT FREEZE？** 是。

---

## Final State

**P30-0 State: PASS — READY FOR CONTRACT FREEZE**
