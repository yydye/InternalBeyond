# P30-4 Blog Conversation Scope Contract
## Request-Origin Scope / Authorization Handoff / Scoped Injection

阶段性质：**CONTRACT DESIGN + FREEZE ONLY / NO PRODUCTION IMPLEMENTATION / NO PRODUCTION MUTATION /
NO DB MIGRATION / NO COMMIT**。本文档不含实现。

上游：P30-3（Blog Conversation Scope Audit COMPLETE：B · Scope Missing / READY_FOR_CONTRACT）·
P30-1（Workspace 契约 FROZEN）· P30-2（Workspace 实施 PASS）· P29（Identity Closure LOGICALLY FROZEN）。

---

## 1. State

**P30-4 State: PASS — CONTRACT FROZEN / READY FOR IMPLEMENTATION**

**Blog Conversation Scope Contract FROZEN**；下一阶段 = **P30-5 · Blog Conversation Scope Implementation**。
本阶段未修改任何 production 文件（唯一制品 = 本文档）。

---

## 2. Upstream Facts

| 事实 | 证据 |
|---|---|
| 两个队列是模块级全局数组，无 scope | `workspace.js:1124-1125`（`_blogPendingReads` / `_blogReadFeedback`） |
| 消费是 take-all + 破坏性 | `workspace.js:1244 _getBlogReadInjection()`（无参数）→ `:1255` / `:1260` 直接置空 |
| 跨会话泄漏已实证（F1/F2） | 另一角色的 1:1 prompt 收到 blog feedback / 用户授权正文，`queueAfter=0` |
| 条目无 scope / 无 actor | P30-3 F2：pending read keys = `["title","content","range","total"]` |
| severity | MEDIUM-HIGH（载荷是用户私有日志正文 + 破坏性丢失） |
| 分类 / 决策 | B · Scope Missing / READY_FOR_CONTRACT |
| registry 永不删除 | `_blogReqReg` 仅声明（`workspace.js:1123`），全仓无 `delete _blogReqReg`；allow/deny 只改 `state` |

---

## 3. Problem

```
model <blog_read>（Conversation A）
      → 待授权 request（**scope 未记录**）
      → 用户在任意会话点击 allow/deny（**scope 被 click-time 状态污染**）
      → GLOBAL queue（无 scope）
      → **任意会话**的下一次注入点 take-all 消费（且清空）
```

⇒ 跨会话可见 + 错误消费 + 破坏性丢失。本契约冻结"scope 从 request origin 一路穿透到注入点"。

---

## 4. WHO / WHERE / WHEN

| 维度 | 含义 | Blog 现状 |
|---|---|---|
| **WHO** | 谁发起/拥有该内容 | Blog **不需要** actor identity（内容属用户；无角色产出）——P29 已冻结，不重开 |
| **WHERE** | 该 item 属于哪个会话 | **缺失**（本契约的核心） |
| **WHEN** | 何时产生/何时消费 | request 时刻（模型轮）· authorization 时刻（用户点击）· 消费时刻（下一次注入） |

冻结：**WHO != WHERE != WHEN**；Blog 的问题是 WHERE，不是 WHO。

---

## 5. Canonical Scope

```js
// 唯一 canonical source（禁止复制内部逻辑）
chat-core.conversationIdOf(friendId, threadId)   // chat-core.js:104-109
```

* **stored facts** = `friendId` + `threadId`（新增 additive 字段）；
* **derived comparison** = `conversationIdOf(friendId, threadId)`（比较时当场派生）；
* **禁止**：新增 `blogConversationId` / 存储 `conversationId` 字段 / 复制 `conversationIdOf` /
  用 actor·name·senderName·author 推导 scope / `BlogConversationManager` / `BlogScopeRegistry` / Session abstraction。

---

## 6. Request-Origin Capture

**最高优先级 invariant**：

> **BLOG REQUEST SCOPE IS CAPTURED AT REQUEST ORIGIN.**

```js
_execBlogReadOps(ops, scopeSrc)      // 概念签名（P30-5 实施）
// scopeSrc 只来自调用方**已有的** conversation context：
//   communication.js:3184（1:1 流式） / :3297（1:1 非流式）→ { friendId:_targetFriend, threadId:_targetThread }
```

**禁止**：`_execBlogReadOps` 内部读取 UI 当前活动会话（`activeFriendId` / `activeThreadId`）。
理由：producer origin 才是事实；UI 指针只是**当时的**视图状态。

---

## 7. Request Registry

冻结 **`_blogReqReg[uid]` 必须能携带 request-origin scope**：

```js
// 真实既有字段（workspace.js:1166）+ additive scope
{ state, postId, title, from, chars, charCount, total, tokens, friendId?, threadId? }
```

* **scope 捕获时机 = 创建 registry entry 时**（`:1166`）；
* 不是 `_brAllow` 时、不是 `_brDeny` 时、不是 `_getBlogReadInjection` 时；
* 若 request origin 有 scope ⇒ **必须 preserve**；
* **lifetime 审计结论**：registry 是模块级对象，**全仓无删除/清理路径**，`_brAllow`/`_brDeny` 只翻转
  `state`（`:1222` / `:1239`）⇒ **用户切换会话后 registry 仍在**。
  ⇒ §22 的 BLOCKED 条件（"切换后 registry 不存在"）**未触发**。

---

## 8. Authorization Handoff

```
requestScope = { friendId:_blogReqReg[uid].friendId, threadId:_blogReqReg[uid].threadId }

_brAllow(uid) → 正文与后续 feedback **继承 requestScope**
_brDeny(uid)  → 反馈 **继承 requestScope**
```

* **禁止**把 `activeFriendId` / `activeThreadId` 当作 ownership authority；
  它们可以用于 UI（渲染/滚动/提示），**不能**用于语义归属；
* `_brAllow` 现有的 `var _tf=activeFriendId`（`:1211`，用于"对方正在回复中"守卫）保持其**UI/并发守卫**用途，
  不得升级为 scope 来源。

---

## 9. Pending Read Contract

```js
// 既有真实字段（P30-3 F2 keys 实证）+ additive scope
{ title, content, range, total, friendId?, threadId? }
```

* scope **继承 request-origin**（`_blogReqReg[uid]`），**禁止** allow-click 时的当前会话；
* 其余字段与文案一律不变。

---

## 10. Feedback Contract

**形状变更（P30-3 已确认必要）**：

```js
_blogReadFeedback : string[]  →  { text, friendId?, threadId? }[]
```

* `text` 为唯一正文承载字段（沿用现有文案）；
* **禁止**把 `string | object` 的联合类型当作长期 canonical runtime shape；
* 读侧（`_getBlogReadInjection`）在**过渡期**可容忍 legacy string（§11），但写入侧一律写对象。

---

## 11. Legacy Compatibility

**冻结选择：A — `string` = legacy unscoped ⇒ 保持现有 fallback。**

| 输入 | 处理 |
|---|---|
| `{text, friendId?, threadId?}`（新形状，有 scope） | 按 §17 过滤 |
| object 但无 `friendId`（无 scope） | legacy unscoped ⇒ 保持既有 fallback |
| **`string`**（hot reload / 旧调用 / 测试残留） | 视为 legacy unscoped：读侧按 `String(f)` 渲染，**放行**（不丢、不炸） |

* 不凭空制造 migration（队列 runtime-only，§23）；
* 不因为形状变更而丢弃历史字符串（那会让用户看到"没有反馈"）。

---

## 12. Consumer Contract

**冻结签名方向：`_getBlogReadInjection(scopeFilter)`**（候选 A），理由：

1. 与 P30-2 已落地的 `_getWsReadInjection(filterFn)` 等**同形**——same take/keep 机制，最小改动；
2. filter 来源可复用同一谓词函数（§16），避免在函数内部各写一套比较；
3. 避免 `(friendId, threadId)` 双参版本与既有 `filterFn` 风格分叉。

消费者（仅既有路径）：

| 调用点 | 必须传入 |
|---|---|
| `communication.js:1729`（1:1 context） | `_ibWsScopeFilter(String(opts.friendId‖cfg.id‖''), opts.threadId)` |
| `communication.js:4463`（tool continuation） | `_ibWsScopeFilter(o.friendId, o.threadId)` |
| 群聊 | **不调用**（既有契约：群聊不注入 Blog 阅读申请；本契约不新增群聊行为） |

**禁止**：继续使用无参数 take-all 形式。

---

## 13. Destructive Consumption Invariant

> **BLOG CONSUMER MUST NEVER REMOVE ANOTHER CONVERSATION'S SCOPED ITEM.**

* Consumer may remove **only**：① 与自己 scope 匹配的 item；② 按 §11 legacy 规则被消费的 unscoped item；
* **禁止** `clear → filter`（当前实现正是 `read all → clear arrays`，`:1255`/`:1260`）；
* 必须 `partition / take-keep`：TAKE = matching current scope；KEEP = other scope（留在原队列）。

---

## 14. Ordering

* 每个 global queue 内 **FIFO preserved**；
* scope filtering 后：**nonmatching relative order unchanged**，**matching relative order unchanged**；
* **禁止**引入 per-conversation map / sorting / priority。

---

## 15. Lifetime

```
Blog item lifetime = ONE-SHOT / CURRENT OWNING CONVERSATION UNTIL CONSUMED
```

不是：global next consumer · actor inbox · persistent memory · turnId-only。

产品证据：注入文案「**仅本轮注入，后续轮次不再携带**」（`workspace.js:1249`）⇒ 由 owning conversation
成功消费后即删除；未被消费则保留（§13）。

---

## 16. Auto Continuation

**冻结选择：A — 自动续答目标 = request-origin conversation。**

现状证据：`_brAllow` 调用 `sendChatMessage()`（无参数，`:1229`），而 `sendChatMessage` 的目标是
`_targetFriend = _callTurn ? _callTurn.roleId : activeFriendId`（`communication.js:2158`）⇒
**当前实现只能对"活动会话"发送**，没有通用显式目标参数。

**冻结最小合法行为**：

1. 若 request-origin 会话 **仍是当前活动会话** ⇒ 允许自动续答（发往 A，与今天行为一致）；
2. 若用户已切走 ⇒ **抑制自动续答**，只把正文留在队列（scoped item 仍属于 A，A 的下一条消息会消费）；
3. **任何情况下不得**把自动续答发往 click-time 活动会话 B；
4. 未来若引入显式会话目标 API，可用它替代"抑制"策略——那是 P30-5+ 的可选增强，**不是**本契约的必要条件。

---

## 17. Conversation Switch（User Switch Scenario）

| 时刻 | 事件 | 冻结结果 |
|---|---|---|
| T0 | Conversation A：模型请求 `<blog_read>` | request scope = **A**（捕获于 registry） |
| T1 | 用户切到 Conversation B | registry 仍在（§7），scope 不变 |
| T2 | 用户在 B 点击「允许」 | 正文 item **属于 A**；B **不可见、不可消费**；自动续答按 §16 处理 |
| T2' | 用户在 B 点击「拒绝」 | feedback **属于 A** |

---

## 18. Invalid / Deleted Conversation Edge

若 request-origin 会话在用户授权前被删除 / 不存在：

**EDGE_POLICY_DEFERRED** —— 不阻塞核心契约（§26 of prompt）。

冻结的最低要求（P30-5 必须满足）：**不得**把 scope 重新指向 click-time 活动会话；
候选行为（择一，留待实施阶段按最小改动决定）：① 保留 item 但不自动续答；② 带反馈地安全丢弃；
③ 拒绝该动作。仓库既有实现不给唯一 precedent，因此不在此冻结具体分支。

---

## 19. Feedback Matrix

| # | 场景 | producer（真实位置） | 产生时机 | scope 来源 | stored shape | consumer |
|---|---|---|---|---|---|---|
| F1 | 用户允许 ⇒ 正文 | `_brAllow` → `:1221` | authorization 后 | **registry preserved request scope** | `{title,content,range,total,friendId?,threadId?}` | owning conversation |
| F2 | 用户拒绝 | `_brDeny` → `:1240` | authorization 后 | 同上 | `{text,friendId?,threadId?}` | owning conversation |
| F3 | 日志不存在 | `_execBlogReadOps` → `:1172` | request 评估期 | **request origin** | `{text,friendId?,threadId?}` | owning conversation |
| F4 | 同名多篇 | 同上 → `:1169` | request 评估期 | request origin | 同上 | owning conversation |
| F5 | from 越界 | 同上 → `:1162` | request 评估期 | request origin | 同上 | owning conversation |
| F6 | 已不可读（删除/转私密） | `_brAllow` → `:1215` | authorization 后 | registry preserved | 同上 | owning conversation |

每条均须满足：MATCH ⇒ 消费；**MISMATCH ⇒ KEEP**（留在队列等待 owning conversation）。
**禁止**无依据地把任何一类降级为 global。

---

## 20. Workspace Boundary

| 项 | Workspace（P30-1/P30-2） | Blog（本契约） |
|---|---|---|
| 契约归属 | `docs/P30-1-…-CONTRACT.md` | **本文档（P30-4）** |
| 共享 | `friendId`/`threadId` 词汇 · `conversationIdOf` 比较 · mismatch KEEP 原则 | 同 |
| 不同 | producer = 角色 runtime 输出；无授权环节；四队列 | producer = 模型请求 + **用户授权**；authorization handoff；两队列；一次性消费；legacy string 兼容；自动续答规则 |

⇒ **SAME PRINCIPLE / DIFFERENT CONTRACT**（不合并、不互相引用实现细节）。

---

## 21. Image / File Provenance Boundary

| 项 | 归属 |
|---|---|
| R3 `_ibImageDrain` / `_ibToolDrainImages`（media attribution / 无 actor+scope / `splice(0)`） | **继续排除** → Media Attribution / Queue Scope |
| R4 `projectFiles.lastModifiedBy`（persisted display provenance） | **继续排除** → Workspace File Provenance |

P30-4/P30-5 均不得顺手处理。

---

## 22. P23 / P24 / P29 Boundary

| 边界 | 冻结 |
|---|---|
| P29 identity | 不变。Blog **不需要** `actorId` / `speakerId` / name resolution；不重开 identity |
| P23 | 不变。只复用 `conversationIdOf` 的既有 adapter（`_ibConvId`）；Delivery Runtime **不参与** Blog queue |
| P24 | 不变。群聊当前不调用 Blog injection，**不新增**群聊 Blog 行为；planner / groupTurnId / memberTurnId / participation / targeting 零改动 |

---

## 23. Persistence / DB

| 状态容器 | 形态 | 结论 |
|---|---|---|
| `_blogReqReg`（`workspace.js:1123`） | 模块级 object | runtime-only（无 dbPut/localStorage） |
| `_blogPendingReads`（`:1124`） | 模块级 array | runtime-only |
| `_blogReadFeedback`（`:1125`） | 模块级 array | runtime-only |

⇒ **NO DB migration / NO DB_VER bump**；`DB_VER` 保持 **24**（`core.js:3`）。

---

## 24. Decision Table

| Question | Frozen Decision |
|---|---|
| canonical scope | `chat-core.conversationIdOf(friendId, threadId)`（唯一真源，禁复制） |
| stored scope fields | `friendId` + `threadId`（additive；**不存** `conversationId`） |
| scope capture time | **request 创建时**（`_execBlogReadOps` 建 registry entry 的那一刻） |
| request registry owner | `_blogReqReg[uid]`（既有模块级 registry；新增 additive scope 字段） |
| allow scope source | `_blogReqReg[uid]` 的 request-origin scope（**不是** click-time active） |
| deny scope source | 同上 |
| pending read scope | 继承 request-origin（写入 `_blogPendingReads` 条目） |
| feedback shape | `{ text, friendId?, threadId? }[]`（由 `string[]` 变更） |
| consumer verifier | `_getBlogReadInjection(scopeFilter)`；调用点 1729 / 4463 传入 filter |
| mismatch behavior | **KEEP**（留在队列，FIFO 不变） |
| legacy string feedback | **legacy unscoped**：读侧容忍并按既有 fallback 放行，不迁移、不丢弃 |
| intentionally unscoped | **NONE**（production 无此类条目；测试/诊断入口视为 test-only） |
| auto continuation target | **request-origin conversation**；origin 非活动会话时**抑制自动续答**并保留 scoped item |
| deleted conversation edge | **EDGE_POLICY_DEFERRED**（最低要求：不得把 scope 重指向当前活动会话） |
| DB migration | **NO** |
| P29 change | **NO** |
| P23 change | **NO** |
| P24 change | **NO** |
| Workspace contract change | **NO**（P30-1 契约与 P30-2 实现均不改） |

---

## 25. State Flow

```
REQUEST_CREATED                （_execBlogReadOps；**scope captured = request origin**）
   ↓
WAITING_USER_DECISION          （_blogReqReg[uid].state='pending'；registry 跨会话存活）
   ├─ ALLOW（_brAllow）
   │     ↓ inherit original scope（从 registry 读，不用 active）
   │  PENDING_READ              （_blogPendingReads + {friendId,threadId}）
   │     ↓ owning conversation consumes（MATCH）
   │  CONSUMED                  （item 移除；非匹配项保留）
   │
   └─ DENY（_brDeny）
         ↓ inherit original scope
      FEEDBACK_PENDING         （_blogReadFeedback + {text,friendId,threadId}）
         ↓ owning conversation consumes（MATCH）
      CONSUMED

not-found / multi-match / invalid-range：
REQUEST_EVALUATION → scoped feedback → owning conversation consumes

（本图只是 contract flow；**不实现**任何状态机对象）
```

---

## 26. P30-5 Implementation Plan（只设计，不实施）

**MINIMAL IMPLEMENTATION SURFACE**

| 面 | 文件 | 函数/位置 | 内容 |
|---|---|---|---|
| producer（request） | `assets/js/workspace.js` | `_execBlogReadOps(ops, scopeSrc)`（`:1154`） | 接收 scopeSrc；创建 registry entry 时写入 `friendId/threadId`（`:1166`）；F3/F4/F5 feedback 带同 scope（`:1162/:1169/:1172`） |
| producer（authorization） | 同上 | `_brAllow(uid)`（`:1209`）/ `_brDeny(uid)`（`:1237`） | 从 `_blogReqReg[uid]` 读 scope；正文（`:1221`）与 F6/F2 feedback（`:1215/:1240`）带 scope；自动续答按 §16 只在 origin 活动时触发 |
| producer 调用点 | `assets/js/communication.js` | `:3184` / `:3297` | `_execBlogReadOps(_bp.ops, {friendId:_targetFriend,threadId:_targetThread})` |
| consumer | `assets/js/workspace.js` | `_getBlogReadInjection(scopeFilter)`（`:1244`） | 两队列**分别** take/keep（不得清空非匹配项）；legacy string 按 §11 渲染 |
| consumer 调用点 | `assets/js/communication.js` | `:1729` / `:4463` | 传 `_ibWsScopeFilter(...)`（§16 复用决策） |
| 形状 | — | — | `_blogReadFeedback` 由 `string[]` → `{text,friendId?,threadId?}[]`（读侧兼容旧 string） |

**不做**：新 manager/registry/session/store/event bus；不改 P29/P23/P24；不改 Workspace 契约；
不改 image / file provenance。

---

## 27. Test Contract（P30-5 必须覆盖）

| # | 用例 | 断言 |
|---|---|---|
| C1 | A request → 切 B → allow | B 看不到；**A 收到** |
| C2 | A request → 切 B → deny | feedback 属于 A（B 不可见） |
| C3 | 同角色 Thread X request → 切 Thread Y → allow | Y 不可见；**X 收到**（证明 friendId 单独不足） |
| C4 | 错误会话尝试消费 | 队列长度**不变** |
| C5 | 正确会话消费 | 队列减少（且仅减少匹配项） |
| C6 | multi-match feedback | 带 origin scope；非匹配不消费 |
| C7 | not-found feedback | 同上 |
| C8 | invalid range（from 越界） | 同上 |
| C9 | legacy string feedback | 保持旧行为（不丢、不炸、按 fallback 放行） |
| C10 | 自动续答 | 发往 request-origin；origin 非活动时被抑制且 item 保留 |
| C11 | 两队列独立 | 命中 A 的 pending read 时**不得**清空 B 的 feedback |
| C12 | FIFO | 过滤后 nonmatching / matching 相对顺序均不变 |
| C13 | P30-2 Workspace scope 套件 | 全绿 |
| C14 | P29 identity 套件 | 全绿 |
| C15 | `DB_VER` | = 24 |
| C16 | P24 | 零改动（planner/memberTurnId/targeting/participation） |

---

## 28. Worktree

| 项 | 结果 |
|---|---|
| production mutation | **ZERO**（本阶段未修改任何 production 文件） |
| 新增制品 | `docs/P30-4-BLOG-CONVERSATION-SCOPE-CONTRACT.md`（本文档） |
| 临时 probe | 未使用（本阶段为纯静态审计 + 既有 P30-3 实证） |
| git 操作 | 未使用 `checkout --` / `restore` / `reset --hard` / `clean` / stash；未 stage、未 commit |

---

## 附 · Required Final Questions（Q1–Q40）

1. **Blog scope 的 canonical source？** `chat-core.conversationIdOf(friendId, threadId)`。
2. **是否仍为 friendId + threadId？** 是（存储这两个字段；比较时派生 conversationId）。
3. **scope 必须在哪一刻捕获？** **request 创建时**（`_execBlogReadOps` 建 registry entry 的那一刻）。
4. **为什么不能在 `_brAllow` 时读 activeFriendId？** 用户可能已切换到别的会话；click-time 视图状态不是 ownership 事实（P30-3 §8 场景已实证）。
5. **`_blogReqReg` 是否必须保存 scope？** 必须（它是 request→authorization 的唯一 handoff 载体）。
6. **`_brAllow` 从哪里继承 scope？** `_blogReqReg[uid]`（request origin）。
7. **`_brDeny` 从哪里继承 scope？** 同上。
8. **`_blogPendingReads` shape？** `{title, content, range, total, friendId?, threadId?}`（additive）。
9. **`_blogReadFeedback` 是否必须从 string[] 变 object[]？** 必须（否则无法携带 scope）。
10. **feedback object 最小 shape？** `{ text, friendId?, threadId? }`。
11. **legacy string feedback 如何处理？** 视为 **legacy unscoped**：读侧按字符串渲染并放行（保持既有 fallback），不迁移、不丢弃。
12. **normal production missing scope 是否允许？** **不允许**——origin 会话可知却漏传 = `BUG_MISSING_SCOPE`；运行时按 §11 legacy 路径降级（不新增丢弃规则）。
13. **是否存在 intentionally unscoped production Blog item？** **NONE**（测试/诊断入口视为 test-only）。
14. **`_getBlogReadInjection` 未来必须接受什么 scope 信息？** 一个 scope predicate（`scopeFilter`），由调用方用当前会话 `(friendId,threadId)` 构造。
15. **mismatch 是否 KEEP？** 是。
16. **错误 consumer 是否绝不能删除 item？** 绝不能（§13 invariant）。
17. **两个 Blog queue 是否独立过滤？** 是（一个队列命中不得清空另一个）。
18. **FIFO 是否保持？** 是（matching 与 nonmatching 的相对顺序均不变）。
19. **Blog item lifetime？** ONE-SHOT / CURRENT OWNING CONVERSATION UNTIL CONSUMED。
20. **切换会话后点击 Allow，正文属于哪个会话？** request-origin 会话（A）。
21. **切换会话后点击 Deny，feedback 属于哪个会话？** request-origin 会话（A）。
22. **自动续答应发往哪里？** request-origin；origin 非活动时**抑制**自动续答并保留 scoped item。
23. **同角色不同 thread 是否必须隔离？** 必须（C3）。
24. **friendId 单独是否足够？** 不足（同角色多话题频道共用 friendId ⇒ 必须加 threadId）。
25. **是否复用 `_ibWsScopeFilter`？** 复用（P30-5 原样使用）。
26. **如果复用，它是否需要 rename/generalize？** 语义上它是 generic conversation-scope predicate；名字是 Workspace-flavored ⇒ **可选后续**最小 rename/generalize（如 `_ibConversationScopeFilter` + 保留别名）。**P30-5 不要求**，且禁止为此提前抽 ScopeManager / ConversationScopeService。
27. **是否需要新 Conversation Manager？** 不需要（禁止）。
28. **是否需要新 Queue Manager？** 不需要（禁止）。
29. **是否需要 DB migration？** 不需要。
30. **DB_VER 是否仍为 24？** 是。
31. **是否修改 P29？** 否。
32. **是否修改 P23？** 否。
33. **是否修改 P24？** 否。
34. **是否修改 P30-1 Workspace contract？** 否。
35. **R3 image 是否继续排除？** 继续排除（Media Attribution / Queue Scope）。
36. **R4 file provenance 是否继续排除？** 继续排除（Workspace File Provenance）。
37. **P30-5 最小 production surface？** 见 §26：`workspace.js`（`_execBlogReadOps` / `_brAllow` / `_brDeny` / `_getBlogReadInjection`）+ `communication.js`（两处 producer 调用点、两处 consumer 调用点）+ feedback 形状变更。
38. **是否存在任何 blocker？** 无。唯一 deferred 项 = §18 的 deleted-conversation edge（不阻塞核心契约）。
39. **是否 READY FOR IMPLEMENTATION？** 是。
40. **P30-4 是否可以 CONTRACT FROZEN？** 可以。

---

## Final State

**P30-4 State: PASS — CONTRACT FROZEN / READY FOR IMPLEMENTATION**

**Blog Conversation Scope Contract**
**FROZEN**

下一阶段：**P30-5 · Blog Conversation Scope Implementation**
