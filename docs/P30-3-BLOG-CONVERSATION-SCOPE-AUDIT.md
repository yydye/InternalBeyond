# P30-3 Blog Conversation Scope Audit

阶段性质：**READ-ONLY AUDIT**（唯一制品 = 本文档；零 production mutation；临时探针运行后已删除）。
上游：P30-0（READY FOR CONTRACT FREEZE）· P30-1（CONTRACT FROZEN）· P30-2（Workspace scope closed）。

---

## 0. State

**P30-3 State: AUDIT COMPLETE**

结论：**B · Scope Missing → CONTRACT REQUIRED → READY_FOR_CONTRACT**
（Blog 两个 pending 队列与 Workspace R2 属**同一原则、不同契约**：全局队列 + take-all + 破坏性消费 + 无会话归属。）

---

## 1. Primary Question

> Blog 是否存在与 Workspace R2 同类问题：GLOBAL runtime queue + destructive consumer + 缺少 conversation scope，
> 导致跨会话可见 / 错误消费 / queue loss？

**是（已实证）**：

| 判据 | Blog 现状 | 证据 |
|---|---|---|
| GLOBAL runtime queue | ✅ 两个模块级数组，无任何会话/角色字段 | `workspace.js:1124-1125`（`_blogPendingReads` / `_blogReadFeedback`） |
| destructive consumer | ✅ 读后清空（take-all） | `workspace.js:1255`（`_blogPendingReads=[]`）、`:1260`（`_blogReadFeedback=[]`） |
| 缺 conversation scope | ✅ 条目形状 `{title,content,range,total}` / 纯字符串 | 探针 F2：`keys=["title","content","range","total"]` |
| 跨会话可见 | ✅ 实证 | 探针 F1/F2（另一角色的 1:1 prompt 收到该内容） |
| 错误消费 + loss | ✅ 实证 | 探针 F1/F2 的 `queueAfter = 0` |

---

## 2. Q1 · Producer

### 2.1 Producer matrix

| # | producer 文件:函数 | 产出 | 触发者 | 是否拥有 `friendId` | 是否拥有 `threadId` | 是否有 actor/user identity |
|---|---|---|---|---|---|---|
| P1 | `workspace.js:1154 _execBlogReadOps(ops)` → push 于 `:1162` | `_blogReadFeedback`（from 越界） | **模型** 在某一 1:1 会话里输出 `<blog_read>` | **调用方有**（`communication.js:3184` / `:3297`，均在 1:1 分支，作用域内有 `_targetFriend`）；**函数本身未接收** | 同上（`_targetThread` 可得，未接收） | 无 actor（内容属用户，不是角色产出） |
| P2 | 同上 → push 于 `:1169` | `_blogReadFeedback`（多篇同名） | 同上 | 同上 | 同上 | 无 |
| P3 | 同上 → push 于 `:1172` | `_blogReadFeedback`（不存在） | 同上 | 同上 | 同上 | 无 |
| P4 | `workspace.js:1209 _brAllow(uid)` → push 于 `:1221` | `_blogPendingReads`（**用户已授权的日志正文**） | **用户点击「允许」** | **当场有**：`var _tf=activeFriendId`（`:1211`，同函数还用它做发送中守卫） | 未捕获（`activeThreadId` 可得） | 无 actor（用户动作） |
| P5 | `_brAllow` → push 于 `:1215` | `_blogReadFeedback`（日志已不可读） | 用户点击「允许」 | 同上 | 同上 | 无 |
| P6 | `workspace.js:1237 _brDeny(uid)` → push 于 `:1240` | `_blogReadFeedback`（用户拒绝） | 用户点击「拒绝」 | 调用点可读 `activeFriendId`（函数未捕获） | 未捕获 | 无 |
| （辅助） | `_blogReqReg[uid]`（`:1166`） | `{state,postId,title,from,chars,charCount,total,tokens}` | P1-P3 建登记 | **未记录** | **未记录** | 无 |

**结论（Q1）**：blog item 由**两类**生产者产生（模型请求 / 用户点击），**两者当场都可得 `friendId`**
（模型侧在调用点 `_targetFriend`；用户侧 `activeFriendId`），`threadId` 也可得（`_targetThread` / `activeThreadId`），
但**都没有写进条目**。条目**不含** actor/user identity（这是与 Workspace 的关键差异，不是缺陷）。

---

## 3. Q2 · Consumer

### 3.1 Consumer matrix

| # | 读取位置 | 读哪些队列 | destructive？ | splice/remove？ | take-all？ |
|---|---|---|---|---|---|
| C1 | `workspace.js:1244 _getBlogReadInjection()` | 同时读 `_blogPendingReads` + `_blogReadFeedback` | **是** | **直接置空**（`:1255` / `:1260`，不是 splice） | **是**（无任何 filter 参数） |
| C2 | `communication.js:1729`（1:1 context） | 经 C1 | 是（C1 内部） | — | 是 |
| C3 | `communication.js:4463`（tool continuation） | 经 C1 | 是 | — | 是 |
| （未接线） | 群聊注入（`_buildGroupChatContext`） | **不调用** `_getBlogReadInjection` | — | — | —（既有契约：群聊不注入 Blog 阅读申请） |

**函数签名证据**：`_getBlogReadInjection()` **不接收任何参数**（探针 F3：`Function.length === 0`；源码中无 `filterFn`），
而 Workspace 的四个注入函数**都**接收 `filterFn`（`_getWsReadInjection(filterFn)` 等）⇒ blog 连"过滤能力"都没有。

**结论（Q2）**：blog 消费是**无条件 take-all + 破坏性清空**；不匹配项没有保留机制。

---

## 4. Q3 · Scope Availability

| 生产者 | `friendId` | `threadId` | 缺失点 |
|---|---|---|---|
| `_execBlogReadOps(ops)`（模型侧 P1-P3） | 可得（调用点 `_targetFriend`），**未接收** | 可得，**未接收** | 函数签名缺 scope 参数；`communication.js:3184/3297` 未传 |
| `_brAllow(uid)`（用户侧 P4/P5） | **当场已有**（`:1211 _tf=activeFriendId`） | 可得（`activeThreadId`），未捕获 | push 时未写入；且**点击时的会话**未必等于**申请时的会话**（见 §5.2） |
| `_brDeny(uid)`（P6） | 调用点可读 `activeFriendId` | 同 | 同上 |
| `_blogReqReg[uid]` | 未记录 | 未记录 | 申请登记缺 scope ⇒ 无法把"允许/拒绝"归属回原会话 |

**禁止反推**：本审计未使用 `actor` / `senderName` / `author` / `displayName` 推导 scope；blog 条目**根本没有**这些字段。

---

## 5. Q4 · Conversation Identity

**可以继续复用 `chat-core.conversationIdOf(friendId, threadId)`** —— 证据：

1. blog 只存在于 **1:1（与 tool continuation）** 路径（群聊不注入）：会话键 = `(角色 id, activeThreadId)`，
   与 Workspace 1:1 完全同形；
2. P30-2 已把 1:1/续轮的比较实现为 `_ibWsScopeFilter(friendId,threadId)`（内部只调 `_ibConvId` → `chat-core.conversationIdOf`），
   blog 可直接复用**同一 adapter 与同一字段词汇**（P30-1 §13 已冻结"SAME PRINCIPLE / DIFFERENT CONTRACT"）；
3. **不需要** `BlogConversationManager` / `BlogScopeRegistry` / `conversationId` 副本（也禁止创建）。

**未能复用的情况**：无（没有证据表明 blog 需要另一种会话键）。

---

## 6. Destructive Consumption Proof（实证）

真实浏览器 + 真实 producer/consumer（临时探针，已删除；未改 production）：

### 6.1 feedback 队列（**完全真实**：模型 `<blog_read>` 的 multi-match 分支）

```
producer : _execBlogReadOps([{name:'P303标题'}])，库里两篇同名 ⇒
           _blogReadFeedback = ['日志名称「P303标题」匹配到多篇：《…》《…》，请向用户确认是哪一篇后重新申请']
consumer : **另一个角色 B 的 1:1 会话**的下一条消息
结果     : F1.otherConversationSawFeedback = true
           F1.queueAfter                    = 0      ← 被 B 消费并清空（destructive）
```

### 6.2 pending-read 队列（真实 `_brAllow`；只抑制"自动续答"以复现未消费路径）

```
producer : _brAllow(uid)（用户点击「允许」）⇒
           _blogPendingReads = [{title,content,range,total}]（keys 证明**无 scope、无 actor**）
抑制     : sendChatMessage 置空 —— 等价于既有失败路径 `if(!inp)return;`（workspace.js:1225）
           / 发送被挡（同函数 :1212 的守卫、或 1:1 前置守卫 return）
consumer : **另一个角色 B 的 1:1 会话**的下一条消息
结果     : F2.otherConversationSawBlogContent = true
           F2.queueAfter                      = 0      ← 用户授权的日志正文被别的会话取走
```

**归因说明**：6.1 是端到端真实（无任何模拟）；6.2 的条目同样由真实 `_brAllow` 产生，
仅把"自动续答"（一个 async 发送）抑制掉，以暴露**代码里已经存在的失败分支**（`:1225` 的 `!inp` 早退、
`:1212`/1:1 前置守卫的静默 return）。正常点击路径下自动续答通常在数毫秒内消费掉条目——
这正是该缺陷长期不可见的原因，也说明**"没被消费的残留项"会流向任意下一个会话**。

---

## 7. Severity Classification

**Severity: MEDIUM-HIGH**

| 因子 | 评估 |
|---|---|
| 载荷敏感度 | **高**：`_blogPendingReads` 携带的是**用户私有日志正文**（用户逐次授权才允许注入），比 Workspace 文件操作回执更敏感 |
| 跨会话污染 | 有（实证）：内容进入**另一个角色**的 prompt |
| 破坏性丢失 | 有（实证）：条目被错误会话取走后，原会话永远拿不到；且 UI 文案承诺"**仅本轮注入，后续轮次不再携带**"（`workspace.js:1249`）⇒ 用户的授权被静默浪费 |
| 触发难度 | 中：需要"条目未被自动续答消费"（失败分支）+ 用户在别处先发消息 |
| 为什么不判 HIGH | **无 canonical mutation**、**无 permission bypass**、单用户产品（无跨用户边界） |
| 为什么不判 LOW | 载荷是用户私有内容；且是**破坏性**丢失，不只是显示问题 |

---

## 8. Classification & Decision

**分类：B · Scope Missing**（不是 A：队列既无 scope 也无过滤；不是 C：没有任何证据表明"跨会话共享"是设计需求——
UI 与注释都写明"仅本轮注入"、"请继续"即在本会话续答）。

**决策：READY_FOR_CONTRACT**

> 需要一份**独立于 Workspace** 的 Blog 契约（P30-1 §13 已冻结 "SAME PRINCIPLE / DIFFERENT CONTRACT"）：
> 共享 `(friendId, threadId)` 字段词汇与 `conversationIdOf` 比较原则，但 producer 语义（用户授权动作）、
> lifetime（一次性）与 unscoped 规则各自定义。

---

## 9. 如果需要实现（只列，不实施）

### 9.1 Required fields

```js
// blog runtime item（候选；沿用 P30-1 词汇，不存 conversationId）
_blogPendingReads : { title, content, range, total, friendId?, threadId? }
_blogReadFeedback : { text, friendId?, threadId? }      // 现为纯字符串 ⇒ 需包一层（形状变更）
_blogReqReg[uid]  : { …, friendId?, threadId? }          // 申请时的会话（关键）
```

> ⚠️ `_blogReadFeedback` 现在是**字符串数组**，要带 scope 必须改成对象数组（消费端 `forEach(f=>ctx+='\n- '+f)` 同步调整）。

### 9.2 Producer changes

| 文件 | 改动 |
|---|---|
| `assets/js/workspace.js` | `_execBlogReadOps(ops, scopeSrc)`：接收调用方传的 `{friendId,threadId}`，写入 feedback 条目与 `_blogReqReg[uid]`（**申请时**捕获）；`_brAllow` / `_brDeny` 从 `_blogReqReg[uid]` 取 scope（**不用点击时的 activeFriendId**，否则用户切换会话后允许会记错归属）；`_getBlogReadInjection(scopeFilter)` 增加过滤参数 |
| `assets/js/communication.js` | `:3184` / `:3297` 两处调用传 `{friendId:_targetFriend,threadId:_targetThread}`；`:1729` / `:4463` 两处注入传 `_ibWsScopeFilter(...)` / `_scMine` |

### 9.3 Consumer changes

* 仿照现有 `_getWs*Injection(filterFn)` 的 take/keep 语义：匹配 ⇒ 取出；不匹配 ⇒ **留在队列**；
* **不得**在过滤后仍清空队列（禁止 `splice` 后过滤 / take 后丢弃）；
* `_brAllow` 的自动续答应发往**拥有该请求的会话**（否则仍会错会话消费）。

### 9.4 Tests

C1 跨会话不可见且 KEEP · C2 归属会话可见并移除 · C3 错误会话重复读取队列不变 ·
C4 同角色不同 thread 隔离 · C5 无 scope 的历史/残留条目保持旧行为 · C6 `_brDeny`/multi/not-found 反馈同样受 scope 约束 ·
C7 形状（feedback 对象化）与 legacy 兼容 · C8 复用 `conversationIdOf`、无新 manager · C9 `DB_VER=24` ·
C10 P30-2 workspace suite + P29 身份套件继续全绿。

---

## 10. Stop Conditions 检查

| 停止条件 | 是否触发 |
|---|---|
| 需要新 identity system | **否**（复用 `chat-core.conversationIdOf`） |
| 需要 DB migration | **否**（两队列 runtime-only） |
| 需要 Event Bus | **否** |
| 需要 Session abstraction | **否**（会话 = 既有 1:1 chat conversation） |
| 需要修改 Workspace contract | **否**（本阶段未触碰 `workspace.js` 的 scope 逻辑；实现阶段亦然） |

⇒ 未触发任何停止条件；本阶段只输出审计。

---

## 11. Worktree

| 项 | 结果 |
|---|---|
| production mutation | **ZERO**（未修改任何 production 文件） |
| 新增制品 | `docs/P30-3-BLOG-CONVERSATION-SCOPE-AUDIT.md`（本文档） |
| 临时探针 | `tmp_p303_probe.js`（仓库根，运行后已删除；`git status` 无残留） |
| git 操作 | 未使用 `checkout --` / `restore` / `reset --hard` / `clean` / stash；未 stage、未 commit |

---

## 附 · 必答问题速览

| 问题 | 回答 |
|---|---|
| Q1 谁创建 blog queue item | 模型侧 `_execBlogReadOps`（3 处 feedback）· 用户侧 `_brAllow`（1 处正文 + 1 处 feedback）· `_brDeny`（1 处 feedback）；`friendId` 可得但未写入，`threadId` 可得但未捕获，**无 actor identity** |
| Q2 谁读取 | `_getBlogReadInjection()`（无参数、take-all、清空两个队列）→ 被 `communication.js:1729`（1:1）与 `:4463`（tool continuation）调用；群聊不调用 |
| Q3 scope 可得性 | `friendId`：模型侧在调用点可得、用户侧当场已有；`threadId`：可得未捕获；`_blogReqReg` 未记录 ⇒ **缺失点在"未写入"**，不是"拿不到" |
| Q4 conversation identity | **可复用** `chat-core.conversationIdOf`；无证据需要新键；禁止 BlogConversationManager / ScopeRegistry / conversationId 副本 |
| 分类 | **B · Scope Missing** |
| 决策 | **READY_FOR_CONTRACT** |
