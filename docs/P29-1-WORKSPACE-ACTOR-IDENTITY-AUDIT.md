# P29-1 · Workspace Actor Identity Audit
## Workspace Attribution / Group Context Identity Boundary

阶段性质：**READ-ONLY IDENTITY AUDIT / CONTRACT DISCOVERY / ATTRIBUTION BOUNDARY AUDIT /
NO PRODUCTION MUTATION / NO SCHEMA CHANGE / NO P24 CONTRACT CHANGE / NO COMMIT**。

本阶段**不实现修复**。唯一新增制品 = 本文档（§30）。临时浏览器探针写在系统临时目录并已删除，
仓库内不留残留（§29 已验证）。

---

## 1. State

**P29-1 State: PASS WITH NOTES — CONTRACT DECISION REQUIRED**

已确认（证据见 §3–§9）：

1. Workspace 队列条目的 `actor` 是 **display label**（角色显示名），**不是** canonical identity；
2. 该值由 `_execWsOps(ops, authorName, cfg, …)` 的单点写入产生，而 producer **当场就有** `cfg.id`；
3. `_gInjMine(it) → it.actor === selfName` **是真实的 attribution bug**：同名角色同时匹配，
   实际后果是"先构建上下文的那个人独占该条目，另一个人永远看不到自己的结果"（探针实证）；
4. 该 bug **不改写**他人 canonical 数据（与 P29-0 withdraw bug 的严重性不同）；
5. 另有同域的第二类问题：队列是**全局**的，未过滤消费者（1:1 context / tool continuation / 图片回注）
   会把群聊产生的条目注入到**另一个会话/角色**的 prompt（探针实证）。

需要冻结的决策见 §20 与 §27；这些决策不影响"问题存在"这一事实。

---

## 2. Primary Finding

### 2.1 `actor` 到底是什么？

**答案：A（display label），并且是该字段在整个 workspace 链路里的唯一语义。**

不是 B（canonical identity）：条目上不存在 `actorId` / `speakerId` / `roleId` / `configId`。
不是 C（legacy mixed field）：它自始至终只有一种含义——显示名。
不是 D（不同路径语义不同）：四条队列（read / op feedback / run output / tool result）同源同形，
都由 `_execWsOps` 的 `authorName` 参数写入。

### 2.2 `_gInjMine(it) → it.actor === selfName` 是否构成真实 identity attribution bug？

**是。** 判据（不是字段名猜测，而是探针实证）：

| 证据 | 结果 |
|---|---|
| 条目形状 | `keys=["actor","text"]`，`canonicalKeys=[]`（**零** canonical 字段） |
| 同名双角色谓词 | `_gInjMine` 判据对 A、B **同时**为 `true`（`{A:true,B:true}`） |
| 真实后果（群聊） | 由 **B** 产生的工作区反馈被 **A** 消费进入 A 的 prompt；**B 自己看不到自己的反馈** |
| 真实后果（跨会话） | 同一批群聊反馈被**无关的 1:1 会话**（角色 C）消费并注入其 prompt |

严重性定位：**attribution / prompt-visibility 污染**，不是 ownership、不是 permission；
**不会**改写他人 canonical 行（见 §16）。

---

## 3. Full Workspace Actor Dataflow

```text
① 模型回复文本（含 <ws_read>/<ws_create>/<ws_tool>/<ws_run> 或"声称已创建"文字）
      │
      ▼
② 解析 + 执行入口
   · 群聊：communication.js:2687-2691  _parseWsOps(reply) → _execWsOps(_gws.ops, selfName, cfg, …)
   · 1:1 流式：communication.js:3144        _execWsOps(_wsParsed.ops, cfg.nickname||cfg.model||'AI', cfg, …)
   · 1:1 非流式：communication.js:3256      _execWsOps(_wsNs.ops, cfg.nickname||cfg.model||'AI', cfg, …)
   · 工具续轮：communication.js:4455        _execWsOps(_cExec, o.senderName||cfg.nickname||cfg.model, cfg, …)
   · 续写：workspace.js:1048                _execWsOps(deltaOps, cfg.nickname||cfg.model||'AI', cfg)
   · 通用：workspace.js:657 (_processWsResponse) → _execWsOps(parsed.ops, authorName, cfg)
      │
      ▼
③ **actor assignment 的唯一 choke point**：workspace.js:323 `_execWsOps(ops, authorName, cfg, ictx)`
      │   所有队列条目都在这里写成 actor = authorName（display name）
      ├─ workspace.js:436   _wsPendingReads.push({path, projectId, actor:authorName, total, content, range?})
      ├─ workspace.js:388/495/516/518/520/522   _wsPendingOpFeedback.push({actor:authorName, text})
      ├─ workspace.js:683-698 _wsCheckPhantom(cleanText, opsCount, actor) → _wsPendingOpFeedback.push({actor, text})
      ├─ workspace.js:488   _rCtx.author=authorName → run.js:203 _wsPendingRunOutputs.push({actor:ctx.author, text})
      ├─ site-operations.js:325/341 _ibExecToolOp(op, author, ictx)
      │      → site-operations.js:292/359/373/394/406/410/416 _ibToolPendingResults.push({actor:author, images, text})
      └─ workspace.js:390/462 / communication.js:2536 _ibImageDrain.push(dataUrl)   ← **无 actor 字段**
      │
      ▼
④ 存储 / 运行期状态
   · 四条队列 = 模块级数组（runtime-only）：workspace/files.js:4,6 · workspace/run.js:12 · site-operations.js:237
   · 以 live getter 暴露到 window（仅供诊断/测试）：files.js:1276,1277 · run.js:276 · site-operations.js:478,480
   · 图片队列 `_ibImageDrain` = 裸 dataUrl 字符串数组（site-operations.js:239）
      │
      ▼
⑤ 读取 / 检索（4 个注入点）
   · 群聊：communication.js:1848  _getWsReadInjection(_gInjMine) + _getWsOpFeedbackInjection(_gInjMine)
                                   + _getWsRunOutputInjection(_gInjMine) + _getIbToolResultInjection(_gInjMine)
   · 1:1 ：communication.js:1724  同四个函数，**无 filter**
   · 工具续轮：communication.js:4417 同四个函数，**无 filter**
   · 图片：communication.js:2536(群) / 2950(1:1) / 4425(续轮) `_ibImageDrain.splice(0)` **无 filter、无 actor**
      │
      ▼
⑥ _gInjMine（群聊 filter，communication.js:1847）
   `it.actor === selfName`（显示名等值）；否则 `isFirstTurn && (!actor || allNames 不含该 actor)` 兜底
      │
      ▼
⑦ group context 尾部注入：communication.js:1849 → _buildGroupChatContext 的 _gTailCtx
      ▼
⑧ 成员 prompt：communication.js:2516 buildChatContext(cfg,{isGroup:true,…,history:messages}) → 该成员请求
```

关键事实：**filter 只在群聊存在**；1:1 与 tool continuation 是 take-all；图片队列连 actor 都没有。

---

## 4. Actor Producers

| Producer | actor 来源 | canonical? | persisted? | consumers |
|---|---|---|---|---|
| `workspace.js:323 _execWsOps(ops,authorName,cfg,ictx)` | 调用方传入的 **显示名** | **否** | 否（仅内存队列） | 4 条队列 + 4 个注入点 |
| `workspace.js:436 _wsPendingReads.push` | `authorName` | 否 | 否 | `_getWsReadInjection(filter)` |
| `workspace.js:388/495/516/518/520/522 _wsPendingOpFeedback.push` | `authorName` | 否 | 否 | `_getWsOpFeedbackInjection(filter)` |
| `workspace.js:683/694 _wsCheckPhantom(…,actor)` | 调用方传入（群聊= `selfName`） | 否 | 否 | 同上 |
| `workspace.js:488 _rCtx.author` → `run.js:203 _wsPendingRunOutputs.push` | `authorName` | 否 | 否 | `_getWsRunOutputInjection(filter)` |
| `site-operations.js:292/359/373/394/406/410/416 _ibToolPendingResults.push` | `author`（来自 `_execWsOps`） | 否 | 否 | `_getIbToolResultInjection(filter)` |
| `workspace.js:390/462 / communication.js:2536 _ibImageDrain.push` | **无 actor**（裸 dataUrl） | 否 | 否 | 图片注入（无过滤） |
| `workspace/files.js:108/115/174 wsSaveFile/wsEditFileContent(...,author)` | `authorName` | **否** | **是**（`projectFiles.lastModifiedBy`，IndexedDB） | 显示（files.js:996）+ **语义**（workspace.js:32） |
| `workspace.js:587/594 卡片闭包 d.author` | 执行时捕获的显示名 | 否 | 否（DOM 内存态） | 用户点「运行/执行」后回到队列 |
| `workspace/run.js:243 author:'User'` | 硬编码字面量 | 否 | 否 | 用户手动运行的输出队列 |

### 谁第一次把角色身份压缩成 display name？（§3 关键问题）

**`_execWsOps` 的调用方。** 群聊路径 `communication.js:2689` 传 `selfName`，
而 `selfName = cfg.nickname||cfg.model`（`:2456`）——**在那一刻，caller 手里同时握着 `cfg.id`**，
却只把 `cfg.nickname||cfg.model` 交出去；`_execWsOps` 随后把这个字符串写进四条队列。

压缩发生在 **producer 的入参**（不是 reader、不是存储层）；这也意味着修复可以在同一个点完成
（§12）。

---

## 5. Actor Consumers

| 位置 | 比较 | 分类 | risk? |
|---|---|---|---|
| `communication.js:1847 _gInjMine` | `it.actor === selfName` | **ATTRIBUTION + PROMPT_VISIBILITY（ROUTING）** | **是**（同名歧义；探针实证） |
| `workspace.js:667 / 723 / run.js:208 / site-operations.js:435` | `filterFn(it) ? take : keep` | ROUTING（消费式派发） | 由 filter 决定；无 canonical ⇒ 见上 |
| `communication.js:1724`（1:1）· `4417`（tool 续轮） | **无 filter**（take-all） | PROMPT_VISIBILITY（跨会话） | **是**（§8 s2） |
| `communication.js:2536/2950/4425` 图片注入 | **无 filter、条目无 actor** | PROMPT_VISIBILITY | **是**（图片跨角色可见） |
| `workspace.js:32`（导入撞名） | `lastModifiedBy==='User'/'你'/'导入'` | **SEMANTIC（ROUTING：是否改名避让）** | 是（display 名参与语义判断；§26） |
| `workspace/files.js:996` | `lastModifiedBy` 渲染 | DISPLAY | 否 |
| `workspace.js:587/594` | `d.author` → 闭包 | DISPLAY/PROVENANCE（回传队列） | 否（值来自同一 producer） |
| `communication.js:1848` 四个 `_get*Injection(_gInjMine)` | 注入文本 | PROMPT_VISIBILITY | 由 `_gInjMine` 决定 |

"是不是我的 / 结果属于谁 / 谁能看到 / 注入哪个角色 prompt / 路由给谁"五条判据中，
`_gInjMine` 命中**四条**（除"谁能看到"外，严格说它也决定"谁能看到"）——因此必须列为 risk。

---

## 6. Workspace Data Shape

实际字段（未设计新结构，逐字段抄自源码）：

```js
// ① 文件读取（workspace.js:436）
{ path, projectId, actor, total, content, range?: {from, to} }

// ② 操作反馈（workspace.js:388/495/516/518/520/522/688/694）
{ actor, text }

// ③ 脚本运行输出（workspace/run.js:203）
{ actor, text }

// ④ 工具调用结果（site-operations.js:292/359/373/394/406/410/416）
{ actor, images: [dataUrl…], text }

// ⑤ 图片回注（site-operations.js:239）
[ dataUrl, … ]              // 裸字符串，无任何身份

// ⑥ 持久化：workspace 文件（workspace/files.js:115）
{ id, projectId, path, content, size, created, lastModified, lastModifiedBy }
```

是否存在可作为 canonical actor identity 的字段？

| 候选字段 | 是否出现在这些对象上 |
|---|---|
| `actorId` | **否**（workspace 全链路零出现；该词汇在 P25/P26 里已是 canonical） |
| `speakerId` | 否 |
| `roleId` | 否 |
| `configId` / `config_id` | 否 |
| `friendId` | 否 |
| `ownerId` / `createdBy` | 否 |
| `sourceRoleId` | 否 |

⇒ **当前 Workspace op/result 不携带任何 canonical actor identity**（探针 `canonicalKeys=[]` 实证）。

---

## 7. Persistence

| 对象 | 分类 | 证据 |
|---|---|---|
| `_wsPendingReads` / `_wsPendingOpFeedback` / `_wsPendingRunOutputs` / `_ibToolPendingResults` / `_ibImageDrain` | **RUNTIME_ONLY** | 模块级数组（files.js:4,6 · run.js:12 · site-operations.js:237,239）；全仓库无 `dbPut`/`localStorage` 写入它们的证据 |
| workspace 文件作者 | **INDEXEDDB**（`projectFiles.lastModifiedBy`） | files.js:108/115/174 写；files.js:996 读（显示）；workspace.js:32 读（语义） |
| chatMessages 里的 workspace 产物 | CHAT_MESSAGE_METADATA（`aiMsg.images` / `wsSearches` / `memOps`） | 由**执行该回复的成员本人**写入，不含 `actor` 字段 ⇒ 不属于本 bug |
| Memory / Home Node | 无 | 见 §21 |

**`actor` 字段本身是否进入持久化数据？** 队列条目**没有**；但**同一个显示名字符串**被持久化到
`projectFiles.lastModifiedBy`（写入者是 `wsSaveFile`/`wsEditFileContent` 的 `author` 参数，
读取者是 UI 显示 + `workspace.js:32` 的改名判断）。

---

## 8. Legacy Data

规则复用的适用性判断（P29-0 / P24-M2 原则）：

| 原则 | 是否适用 | 理由 |
|---|---|---|
| canonical present ⇒ canonical wins | **适用** | 一旦 producer 写入 `actorId`，reader 直接比较 id（无歧义、无解析） |
| canonical absent ⇒ legacy unique exact display-name | **适用（有前提）** | 需要"当前会话的候选角色集"（群= `groups.members`；1:1= 该角色一人）——两处在读者侧都已有 canonical 来源 |
| ambiguous ⇒ UNKNOWN / not mine | **适用** | 正是当前缺陷的修复语义 |
| invalid ⇒ UNKNOWN / not mine | **适用** | resolver 的既有 fail-closed 语义 |

**"legacy 数据"在本问题上几乎不存在"历史堆积"**：四条队列是 runtime-only（刷新即清空），
因此没有需要迁移的存量；"legacy"只指**同一次会话内、producer 尚未写入 id 的条目**
（过渡期窗口）。真正带历史的 display 字符串是 `projectFiles.lastModifiedBy`（§26）。

⇒ 规则适用；但**本阶段不实现**。

---

## 9. Same-name Reproduction

只读浏览器探针（真实页面 + 最小 mock provider，真实生产路径，**未改 production**；
脚本写在系统临时目录并在运行后删除）。fixture：A/B 同显示名"希儿"（id 不同）、第三者 C；
让**B** 的回复触发真实 producer（`_wsCheckPhantom` 的 claim 分支）。

```text
page.ready                      = true
fixtures.sameName               = true
# Scenario 1 · 真实 producer 产出条目
s1.turn1Rows                    = true
s1.queueAfterClaim              = [{"keys":["actor","text"],"actor":"希儿","canonicalKeys":[]}]
s1.degradedSnapshot             = {}            # P29-0 身份退化诊断：空（与本问题无关，见 §17）
s1.predicateBothTrue            = {"A":true,"B":true}   # _gInjMine 判据对 A、B 同时为真
# Scenario 1b · 下一轮群聊：谁先构建上下文谁吃掉
s1.turn2Rows                    = true
s1.modelA_sawB_feedback         = true          # A 的请求里出现 B 的工作区反馈
s1.modelB_saw_own_feedback      = false         # B 看不到自己的反馈
s1.queueAfterTurn2              = []            # 已被消费
# Scenario 2 · 跨会话：B 的新条目被 1:1 的 C 消费
s2.queueBeforeSingle            = [{"keys":["actor","text"],"actor":"希儿","canonicalKeys":[]}]
s2.modelC_sawB_group_feedback   = true          # 无关会话/角色拿到群聊反馈
s2.queueAfterSingle             = []
```

回答 §8 的两个问题：

* **A sees result = true？** 是（先构建上下文者真拿到）。
* **B sees result = true？** **否**（B 自己的结果被 A 吃掉，B 的 prompt 里没有）。
* 更强的一条：**C（无关 1:1 会话）也 sees = true** —— 问题不是同名专属，而是归属域缺失。

---

## 10. Attribution vs Permission

| 概念 | 定义 | `_gInjMine` 是否属于 |
|---|---|---|
| ATTRIBUTION | "这条 workspace result 属于谁" | **是（主）** |
| PROMPT VISIBILITY / ROUTING | "谁的模型上下文能看到 / 注入哪个角色 prompt" | **是（直接后果）** |
| PERMISSION | "谁有权执行/读取 workspace" | **否**（没有任何授权由它决定；执行权限在 `_execWsOps` 之前已由 `_mbSideEffectGate` 等裁定） |
| OWNERSHIP | "谁拥有/能否改写这条 canonical 数据" | **否**（不改写任何 canonical 行） |

⇒ 结论：**attribution（含可见性/路由）**。因此**不得**升级为 Authority。
禁止创建（且仓库不存在可复用者）：`WorkspaceAuthority` / `WorkspaceIdentityAuthority` /
`WorkspacePermissionManager`。

---

## 11. Canonical Actor Candidates

| 候选 | 稳定 | canonical | 跨会话稳定 | 已有 P24/M2 定义 | producer 当场可得 | 需要 DB/schema |
|---|---|---|---|---|---|---|
| **`cfg.id`（= `apiConfigs.id`）** | 是 | **是**（与 `metadata.speakerId` 同一 domain） | 是 | 是（P24-M2 §1） | **是**（每个 `_execWsOps` 调用点都传了 `cfg`） | 否 |
| `roleId` | 是 | 是（域 store 的角色键，取值同域） | 是 | 是（Moments/Activity/Diary 等） | 是（= `cfg.id`） | 否 |
| `speakerId` | 是 | 是（chat message 契约字段） | 是 | 是（P24-M2） | 否（workspace 条目不是 chat message） | 否 |
| `friendId` | 是 | 是（会话目标键） | 是 | 是（chat-core） | 是 | 否 |
| group member id (`groups.members[].characterId`) | 是 | 是（同域） | 是（成员表可变，但 id 稳定） | 是 | 否（需要 group 上下文，producer 未必有） | 否 |
| 新 UUID | — | 否 | 是 | **否**（第二身份） | 否 | 可能需要 |

⇒ **唯一合适的来源是 `cfg.id`**（producer 当场可得、零新契约、零 schema）；
**不要**引入新 UUID（§25 禁止第二身份）。

---

## 12. actor / canonical identity semantics

设计判断（只判断，不实现）：

```text
actor    = display only（既有文案不变：'希儿' / 'User' / '你' / '导入' / 'AI'）
actorId  = canonical attribution identity（= cfg.id）
```

**先检查仓库是否已有更合适的字段名**：

| 既有词汇 | 含义 | 出处 | 是否适合本场景 |
|---|---|---|---|
| `actorId` | **canonical** 角色/模块 id | `autonomy-core.js:113`、`diary-authority.js:93`、`active-message-authority.js:100`、`moments-mutation-authority.js:98`、`domain-event-core.js`（ALLOWED_FIELDS）、`agent-orchestration-core.js:132/145` | **适合**（同一语义：canonical actor；且 workspace 条目不是 chat message） |
| `speakerId` | canonical **chat message** 作者 | P24-M2 / `metadata.speakerId` | 不建议（语义绑定 chat message 契约；workspace 条目不是消息） |
| `roleId` | 域 store 的角色键 | Moments/Diary/Activity | 可行但语义更窄（**域**角色），workspace 是跨域工具面 |
| `config_id` | apiConfigs 兼容键 | M1 之前写入点 | 不建议（新契约不应沿用旧兼容名） |

⇒ **建议 `actorId`**（复用既有 canonical 词汇），并明确 `actor` 降级为 display-only。
这不是"因为提示词这么写"，而是因为 P25/P26 已经用 `actorId` 表示同一个概念。

**词汇冲突本身也是发现**：同一个 `actor` 在本仓库有第三种含义——
`agent-orchestration-core.js:145` 的 `actor: {id: …}`（对象形式的 canonical actor），
而 workspace 用 `actor: '希儿'`（字符串 display）。这属于 §26 的 vocabulary risk。

---

## 13. Writer Ownership

* Canonical producer / choke point = **`workspace.js:323 _execWsOps`**（四条队列的唯一写入口）。
* 冻结（§12 原则）：未来修复必须**在 producer 尽早保留 canonical identity**——
  `_execWsOps` 已收到 `cfg`，因此 `actorId: (cfg&&cfg.id)||''` 在这一点零成本可得。
* **禁止**采用"result 生成后按 `actor` 显示名反查角色"的重建方案（那正是 §3 的压缩路径，
  且在同名时会重建错人）。原则：**identity should be preserved, not reconstructed later。**
* 事件的源头在**模型回复的执行点**（群聊 `communication.js:2689`），那里同样握着 `cfg`。

---

## 14. Reader Ownership

`_gInjMine` 所在 context builder（`_buildGroupChatContext`）的职责应是：
**只消费已经 canonicalized 的 actor identity**，而不是自己 resolve 身份。

但在过渡期（producer 尚未写入 id）需要 legacy 解析，此时：

* **应该复用** `IBGroupRuntime.resolveSpeakerId` / `classifyMessageForSpeaker`（M2 唯一 resolver），
  **不要**创建 workspace 专用 resolver；
* 机制上需要一个薄 wrapper 把 workspace 条目映射成 resolver 期望的形状（`{senderName: it.actor}`）
  并把"当前会话候选角色"作为 `participants` 传入——见 §18 的 ADAPT_WITH_WRAPPER。
* 1:1 场景的 participants = 当前角色一人（唯一精确匹配语义天然成立，行为不变）。

---

## 15. Group Boundary

分类结论：**WORKSPACE_GLOBAL（同名放大效应才是 GROUP_ONLY）**。

| 维度 | 事实 |
|---|---|
| 队列作用域 | 全局模块态数组，**不含** conversationId / friendId / groupId（§6 字段表） |
| 同名歧义 | 需要**同一归属域内 ≥2 个同名角色** ⇒ 群聊才具备（1:1 会话内只有一个角色） |
| 非同名越界 | **不需要同名**：探针 s2 中"群聊 → 1:1（角色 C）"就发生了跨会话消费 |
| 单聊是否使用 workspace result attribution | **使用**，但方式是"无 filter 全取"（`communication.js:1724`）：它不做归属判断，因此也不会因同名判错；错的是它把**别人的**条目当成自己的 |
| 是否需要改普通 Chat | 取决于 §20 决策 3（是否要求队列按会话隔离）。**不要**因为发现 Group bug 就去改 1:1 语义 |

另注：group 的 **tool continuation** 路径（`communication.js:2689 → _wsToolContinue → :4417`）**绕过**
`_gInjMine` 过滤，直接 take-all；这是群聊内部的第二条越界通道。

---

## 16. Prompt Contamination Impact

| 影响面 | 判定 | 证据 |
|---|---|---|
| 该 result 进入另一个角色的 prompt | **DIRECT** | 探针 `modelA_sawB_feedback=true` / `modelC_sawB_group_feedback=true` |
| 该角色把 result 当成自己的 | **DIRECT（模型层，取决于模型）** | 注入文案为"你上一轮的部分工作区操作…"（workspace.js:671），措辞本身以第二人称指向接收者 |
| 真正 owner 丢失自己的反馈 | **DIRECT** | 探针 `modelB_saw_own_feedback=false`（条目被消费后不再回注） |
| tool / workspace continuity 被污染 | **SECONDARY** | 模型可能据错误反馈重发/不重发工作区指令（无 canonical 写入 ⇒ 不是 DIRECT） |
| 图片回注（`_ibImageDrain`） | **DIRECT** | 无 actor、无 filter；`splice(0)` 取全部（communication.js:2536/2950/4425） |
| Memory | **SECONDARY（模型触发才发生）** | 若模型据错误上下文输出 `mem_*`，走既有 Memory 政策；本 bug 自身不写 Memory |
| Relationship | **NO EFFECT** | 无相关写入路径 |
| Middle Brain | **NO EFFECT** | MB 只做内容组织/完整性，不读这些队列 |
| tool loop | **SECONDARY** | 续轮 prompt 会带错误 feedback（§15 的 take-all 通道） |
| chatMessages | **NO EFFECT** | `aiMsg` 由执行该回复的成员本人写入，不含 `actor`（§7） |
| canonical writer | **NO EFFECT** | 无新 writer、无越权写入 |

不夸大：本问题**不改写任何 canonical 数据**，影响是**上下文污染 + 反馈错配**。

---

## 17. Canonical Mutation Impact

| 问题 | 回答 |
|---|---|
| 修改他人 canonical chatMessage？ | **否**（对比 P29-0：那里是改写他人消息内容；这里只是把文本放进别人的 prompt） |
| 修改 workspace canonical data？ | **间接**（被误导的成员可能**自己**发起新的 ws op；写入仍署名它自己） |
| 修改 Memory？ | 否（除非模型据此输出 mem 指令——属 SECONDARY） |
| 修改 Relationship？ | 否 |
| 修改 permissions？ | 否 |

⇒ 这是 **attribution/context contamination only**。这也是它与 P29-0 withdraw bug 的严重性差异：
P29-0 = 跨角色改写 canonical 行（高）；P29-1 = 跨角色上下文错配（中）。

---

## 18. Identity Degradation Interaction

P29-0 新增的 `_ibGroupIdentityDegraded`（`communication.js:4648`）与 Workspace actor identity **无直接关系**：

* 前者诊断的是"**群成员回合身份构造失败**"（`_gMember === null`，P24 三键写不进消息）；
* 后者是"**工作区队列条目的 actor 只有显示名**"（队列字段缺失，与 P24 消息身份无关）；
* 探针同时观测到：`_ibGroupIdentityDegradedSnapshot() = {}`（**零**退化）而 attribution bug **成立**
  ⇒ 两根因、两系统，**代码证据不支持**把它们绑定。

⇒ 不要把两个诊断系统合并；P29-0 的诊断面无需改动。

---

## 19. P24 Identity Reuse Audit

判定：**ADAPT_WITH_WRAPPER**

| resolver | 语义 | 对 workspace 适用性 |
|---|---|---|
| `resolveSpeakerId(message,{participants})` | 读 `message.metadata.speakerId`（canonical）→ 否则 `message.senderName` 唯一精确匹配；歧义/非法/非本群 ⇒ `unresolved` | 规则**完全适用**（唯一/歧义/fail-closed 正是所需），但字段名不同（`it.actor` vs `message.senderName` + `metadata`）⇒ 需要薄 wrapper 做**机械映射**，不改规则 |
| `classifyMessageForSpeaker(message,currentSpeakerId,participants)` | 返回 `SELF/OTHER/UNKNOWN`，UNKNOWN 永不是 SELF | 同上；`role` 字段缺失时需 wrapper 补一个非 `'user'` 的角色标记（否则被误判 `user-role` ⇒ 永不 SELF） |

**不是** SAFE_REUSE（不能直接把 items 传进去：字段名与 `role` 都不匹配）；
**不是** SEMANTIC_MISMATCH（唯一精确匹配 + 歧义 fail closed 的语义恰好就是我们要的）。
⇒ **ADAPT_WITH_WRAPPER**，且 wrapper 必须放在 reader/注入点，**不得**复制 resolver 逻辑。

---

## 20. Contract Change Classification

若未来新增 canonical actor identity（最小修复），分类：

| 类别 | 是否涉及 | 说明 |
|---|---|---|
| **A. Runtime object enrichment only** | **是（唯一必要项）** | 四条队列条目新增 `actorId`；runtime-only，无持久化、无 schema |
| B. Workspace internal contract change | 可选 | 仅当要把 `lastModifiedBy` 的语义判断（workspace.js:32）也 canonical 化 |
| C. Chat message metadata contract change | **否** | 不写 chatMessages metadata |
| D. P24 identity contract change | **否** | 复用 `cfg.id`（同 domain），不改 P24 |
| E. DB schema change | **否** | 见 §21 |
| F. Home Node contract change | **否** | workspace 数据不跨 runtime（§21） |

⇒ **决定 P29-2 是否可以直接实施的关键结论：只需 A**；B/（图片队列形状变更）是可选扩展。

---

## 21. Schema / DB

* `DB_VER` 当前仍为 **24**（`assets/js/core.js:3`）——本阶段未触碰。
* 未来最小修复**不需要**：new store / migration / DB bump（队列是 runtime-only，§7）。
* 若未来要改 `projectFiles.lastModifiedBy` 的语义来源（把 canonical id 也存下来），
  则需 `projectFiles` 记录新增字段 = **workspace internal contract + schema**（E），
  **本阶段明确不建议**（不是本 bug 的必要条件）。
* `projectFiles` **不参与** Home Node 接管（`home-node-bootstrap.js:163-165` 只接管
  `chatMessages` / `memories` / `understandings` / `moments`）⇒ workspace 文件是浏览器本地真相。

---

## 22. Cross-runtime Boundary

| 运行时 | Workspace actor/result 是否跨越 | 证据 |
|---|---|---|
| Browser | 是（唯一运行位置） | 队列是模块态；`_execWsOps` 与注入点都在浏览器 |
| Node companion | **否** | companion 只处理 Active Message / Moments 事件队列 |
| Home Node | **否** | 接管面不含 `projectFiles`/workspace 队列 |
| Mobile | **否** | 无 workspace 队列通道 |

⇒ 不需要设计 cross-runtime identity protocol（§21 的"仅在 Browser runtime"分支）。

---

## 23. Existing Tests

| 套件 | 与本问题的关系 | 状态 |
|---|---|---|
| `tests/test_workspace_smoke.js` | 覆盖 `_wsPendingOpFeedback` 的真实生产者→消费者（`:257` 直接调用 `_getWsOpFeedbackInjection()`，**未过滤**路径） | 本次运行 **PASS**（`Workspace smoke test passed`） |
| `tests/test_identity_read_path_closure.js` | P29-0 身份读路径闭合（撤回/拍一拍 + 同名 E2E） | 上次运行 54 PASS（本阶段未改 production ⇒ 结论不变） |
| `tests/test_group_speaker_identity.js` | M2 canonical 身份读路径（同名 E2E） | 上次运行 50 PASS |
| `tests/test_group_turn_identity.js` | P24-M1 消息身份（memberTurnId/groupOrder） | 上次运行 99 PASS |
| `tests/test_group_participation_integration.js` | 群聊真实回合（mock provider）——未来同名 attribution E2E 的最佳宿主 | 上次运行 122 PASS |
| `tests/test_p11_3d_tool_execution_guard.js` / `_contract` / `_mutations` | tool 执行 guard（与 `_execWsOps` 同域；**未登记进 test-all.js**） | 未运行（非必需） |
| `tests/test_p11_2h_group_prompt_boundary.js` | 群 prompt 输入边界（harness 早于 P11-3X-C，属**既有基线红**，P27-CLOSURE §22 已登记） | 不运行 |

最适合未来 implementation 的 focused suites：`test_identity_read_path_closure.js`（放同名 attribution 用例）
+ `test_group_participation_integration.js`（真实回合）+ `test_workspace_smoke.js`（兼容未过滤路径）。

§28 的测试预算遵守：只跑了上述直接相关的 1 个套件与 1 个临时探针，**未跑 full quick**。

---

## 24. Implementation Candidate

只提出候选，不实施。

```text
Producer already knows canonical actor（= cfg.id，调用点已持有 cfg）
        ▼
_execWsOps 写入队列条目时同时保留 actorId（+ 事件驱动生产者透传）
        ▼
条目形态：{ actor: '希儿', actorId: 'friend_xxx', text, … }
        ▼
reader 比较 canonical identity（actorId === cfg.id）
        ▼
legacy（无 actorId）⇒ 复用 M2 resolver：唯一精确显示名匹配
        ▼
歧义 / 无法解析 ⇒ UNKNOWN ⇒ not mine（不注入、不消费）
```

最小实现面（建议 P29-2）：

1. `workspace.js:323 _execWsOps` 加 `actorId=(cfg&&cfg.id)||''`，四条 push 同步带上；
2. 事件驱动生产者透传：`_wsCheckPhantom(…, actor, actorId)`（`workspace.js:683`）、
   `_rCtx.authorId`（`:488` → `run.js:203`）、`_ibExecToolOp(op, author, actorId, ictx)`（`site-operations.js:325`）；
3. `communication.js:1847 _gInjMine` 改为 canonical 比较 + legacy 回退（复用 §19 的 wrapper）；
4. 显示文案（`actor`、`lastModifiedBy` 的 UI 呈现）**一字不改**。

仍需先冻结的决策（§27）：**队列是否按会话作用域**、**图片回注是否纳入**、
**未过滤消费者（1:1 / tool continuation）的行为**。

---

## 25. Compatibility Requirements

未来修复必须保持：

1. **display actor 文案不变**（'希儿' / 'User' / '你' / '导入' / 'AI' 原样出现在注入文本与文件 meta 中）；
2. **单聊行为不变**：1:1 仍消费"它自己会话"的结果（不因修复而漏注入）；
3. **唯一名称 legacy 行为不变**：无 id 的旧条目在无歧义时仍可解析到唯一角色；
4. **group planner 不变**（`planParticipation` / planVersion 3 / reason 词表）；
5. **memberTurnId 不变**（公式与取值）；
6. **targeting 不变**（`targetSpeakerIds` 事实不被改写/重解析）；
7. **recent 不变**（`recentSpeakerIds` 派生与消费）；
8. **P23 不变**（五核心零引用）；
9. **canonical writer 不变**（无新写点；`projectFiles`/`chatMessages` 写入者不变）。

---

## 26. Remaining Identity Risks

| # | 位置 | display 进入语义判断？ | 分类 | 备注 |
|---|---|---|---|---|
| R1 | `communication.js:1847 _gInjMine` | 是（attribution/visibility） | **SEMANTIC_RISK** | 本审计主体 |
| R2 | `communication.js:1724 / 4417`（无 filter） | 不判断 = 全取 ⇒ 跨会话错配 | **SEMANTIC_RISK** | 修复 R1 不会自动修它 |
| R3 | `_ibImageDrain`（声明 `site-operations.js:239`；写入 `workspace.js:390/462`、`communication.js:2536`） | 无 actor ⇒ 无归属 | **SEMANTIC_RISK** | 形状变更，需决策。注：另一条 `_ibToolDrainImages`（`site-operations.js:439`）来自**已被 filter 选中**的工具结果 ⇒ 它继承 R1/R2 的缺陷，不是独立缺陷 |
| R4 | `workspace.js:32`（`lastModifiedBy` 名值决定是否改名） | 是（routing） | **SEMANTIC_RISK** | persisted display 名参与语义 |
| R5 | `_messageApiConfig` 的 `senderName` 末位分支 | 否（仅 `_messageShowThinking`） | **DISPLAY_SAFE** | 消费者是显示 |
| R6 | `_getApiAvatarByName` | 否 | **DISPLAY_SAFE** | 头像显示 |
| R7 | `_chatShouldWithdraw`（正文 @名） | 文本启发式，非身份 | **LEGACY_SAFE** | 目标选择已 canonical（P29-0） |
| R8 | M2 resolver 的 legacy 名字分支 | 唯一精确匹配 + 歧义 fail closed | **LEGACY_SAFE** | 契约允许 |
| R9 | `agent-orchestration-core.js:145` 的 `actor:{id}` vs workspace `actor:'希儿'` | 词汇冲突（同名不同义） | **UNKNOWN**（非缺陷，但建议在文档中固定语义） | 未来若统一命名，需显式决策 |

⇒ **P29-1 之后是否还需要 P29-C Identity Closure？**
**需要（但范围收窄）**：chat/group 的 ownership 已在 P29-0 闭合；
剩下的"display identity 进入 semantic decision"清单 = R1–R4。
建议把 R1–R3 并入 **P29-2（Workspace Actor Identity 修复）**，
R4（workspace 文件的 persisted 作者语义）作为 P29-C 的候选条目。

---

## 27. Implementation Readiness

```
## Workspace Actor Identity Implementation Readiness

Status:

PASS WITH NOTES — CONTRACT DECISION REQUIRED
（最小修复片段已在证据上就绪；3 个契约决策必须先冻结）

Required contract changes:

1. （必要）Workspace runtime item contract：队列条目新增 canonical actor 字段（建议 `actorId`），
    `actor` 明确降级为 display-only。类别 = A（runtime object enrichment），无 schema。
2. （必要）Reader 语义：`_gInjMine` 改为 canonical 比较 + legacy 唯一精确名 + 歧义 not-mine。
3. （必要·scope 决策）未过滤消费者与全局队列的会话作用域：
     a) 只修归属（保留 take-all 语义：1:1 仍吃全局队列，可能继续跨会话错配）；或
     b) 队列按会话/角色隔离（修跨会话，需定义 legacy 无归属条目的处置）。
4. （可选决策）`_ibImageDrain` 是否纳入（当前无 actor；处理它需要形状变更，约 4 处调用点）。
5. （可选决策）`projectFiles.lastModifiedBy` 的 persisted 语义判断（workspace.js:32）是否同期处理。

Canonical identity source:

`cfg.id`（= `apiConfigs.id` = P24 `metadata.speakerId` 同一 domain）。
每个 producer 调用点当场可得：`_execWsOps(ops, authorName, cfg, ictx)` 的第 3 参就是 cfg。
字段名建议 `actorId`（复用 P25/P26 既有 canonical 词汇；不用新造名、不用 UUID）。

Producer to modify:

assets/js/workspace.js（`_execWsOps` 及 4 条 push / `_wsCheckPhantom` / `_rCtx`）
assets/js/workspace/run.js（`_wsPendingRunOutputs.push` 的 ctx.authorId 透传）
assets/js/site-operations.js（`_ibExecToolOp` / `_ibQueueToolResult` 的 authorId 透传）

Consumers to modify:

assets/js/communication.js:1847 `_gInjMine`（群聊 filter；canonical 比较 + legacy 回退）
assets/js/communication.js:1724 / 4417（是否改取决于决策 3）
assets/js/communication.js:2536 / 2950 / 4425（是否改取决于决策 4）

Legacy rule:

actorId 存在 ⇒ canonical wins；
缺失 ⇒ 复用 M2 resolver 语义（唯一精确显示名匹配，participants 来自当前会话）；
歧义 / 非法 / 无法解析 ⇒ UNKNOWN ⇒ not mine（不注入、不消费）。

Production files allowed:

assets/js/workspace.js · assets/js/workspace/files.js · assets/js/workspace/run.js ·
assets/js/site-operations.js · assets/js/communication.js（仅上列注入点/filter）+ 对应 tests

Production files forbidden:

assets/js/group-runtime-core.js（P24 identity / memberTurnId / planner / targeting / recent）·
P23 五核心（delivery-planner / multimodal-delivery-policy / delivery-sequence-core /
delivery-runtime / voice-message-core）· assets/js/core.js（DB_VER / schema）·
assets/js/memory.js · assets/js/middle-brain*.js · 各域 canonical writer ·
任何新 Authority / Manager / Bus / store / 第二身份

DB migration:

NO（队列 runtime-only；最小修复不触碰任何 store）

P24 contract change:

NO（复用同一 domain 的 cfg.id；不改 P24 契约、不改 memberTurnId）

Tests required:

1) producer：read / op-feedback / run-output / tool-result 四条队列条目均带 actorId=cfg.id；
2) consumer：同名群（A/B 同显示名）各自只消费自己的条目（复用本审计探针 fixture 变绿）；
3) legacy：无 actorId 的条目走唯一精确名；同名歧义 ⇒ 不注入（fail closed）；
4) compatibility：test_workspace_smoke.js（未过滤路径）· test_identity_read_path_closure.js ·
   test_group_speaker_identity.js · test_group_turn_identity.js 全绿；
5) 差分：display 文案不变；1:1 行为不变；唯一名 legacy 行为不变；
6) （若决策 3=b）跨会话用例：群聊条目不得进入其它会话 prompt。
```

---

## 28. Test Evidence

| 证据 | 命令 | 结果 |
|---|---|---|
| 同名 attribution 复现（真实页面 + mock provider，未改 production） | 临时探针（系统临时目录，运行后删除） | 见 §9 输出：`canonicalKeys=[]`、`{A:true,B:true}`、`modelA_sawB_feedback=true`、`modelB_saw_own_feedback=false`、`modelC_sawB_group_feedback=true` |
| workspace 生产者→消费者冒烟 | `node tests/test_workspace_smoke.js` | **PASS**（`Workspace smoke test passed`） |
| P29-0 身份读路径闭合（未改 production，结论沿用） | `node tests/test_identity_read_path_closure.js` | 54 PASS（上一阶段运行） |
| M2 / P24 身份（同上） | `node tests/test_group_speaker_identity.js` / `test_group_turn_identity.js` | 50 / 99 PASS（上一阶段运行） |

**未跑 full quick**（§28 明令禁止）。

---

## 29. Worktree

| 文件 | 类型 |
|---|---|
| `docs/P29-1-WORKSPACE-ACTOR-IDENTITY-AUDIT.md` | 新增（本文档，唯一制品） |

* 临时探针脚本写在系统临时目录（`%TEMP%`），运行后已删除；`git status` 无该文件残留（已验证）。
* **零 production 变更**：`communication.js` / `workspace.js` / `workspace/*.js` / `site-operations.js` /
  `group-runtime-core.js` / `core.js` 本阶段均未修改。
* 未使用 `git checkout --` / `git restore` / `git reset --hard` / `git clean` / stash；未 stage、未 commit。

---

## 30. Next Stage Recommendation

1. **P29-2 · Workspace Actor Canonical Identity（建议首选）**
   范围 = §27 的第 1–2 项（producer 保留 `actorId` + reader canonical 比较 + legacy 规则），
   外加 §20 决策 3 的二选一。这是**唯一必要**的 contract 类别（A），无 schema、无 P24 改动。
2. **P29-C · Display Identity in Semantic Decision 收尾**
   把 R4（`projectFiles.lastModifiedBy` 的 persisted 语义判断）与 §26 的词汇统一（R9）纳入；
   与 P29-2 可并行或随后。
3. **明确不做**：WorkspaceAuthority / IdentityManager / Event Bus / 新 store / 第二身份 /
   P24 identity v2 / memberTurnId v2（审计未发现任何一条"绝对必要"的证据）。
4. **不要**为了修 attribution 去改 P24 planner / targeting / recent / P23 / 单聊语义。

---

## 附录 · Required Final Questions（Q1–Q30）

1. **Workspace `actor` 当前语义？** display label（角色显示名字符串）；非 canonical。
2. **谁第一次把 canonical role identity 压缩成 display name？** `_execWsOps` 的调用方：
   群聊 `communication.js:2689` 传 `selfName`（= `cfg.nickname||cfg.model`），
   1:1 `:3144/:3256`、续写 `workspace.js:1048` 同款；写入点 `workspace.js:323`。
3. **`_gInjMine(it) → it.actor === selfName` 是真实 attribution bug 吗？** 是（探针实证）。
4. **同名角色能否同时判为 mine？** 谓词上是（`{A:true,B:true}`）；实际是"先构建上下文者独占"，
   另一个角色的结果丢失。
5. **属于 attribution / permission / ownership / routing？** ATTRIBUTION 为主，
   直接后果是 PROMPT_VISIBILITY / ROUTING；**不是** permission/ownership。
6. **会改写他人 canonical message 吗？** 不会。
7. **会污染另一个角色的 prompt/context 吗？** 会（探针：A 得到 B 的反馈；C 的 1:1 也得到）。
8. **Workspace result 已携带 canonical actor identity 吗？** 否（`canonicalKeys=[]`）。
9. **producer 当时是否知道 canonical identity？** 知道——`_execWsOps` 第 3 参就是 `cfg`（含 `.id`）。
10. **preserve 还是 reconstruct？** preserve（producer 当场保留）；禁止 reader 按显示名重建。
11. **P24/M2 resolver 能否安全复用？** ADAPT_WITH_WRAPPER（语义适用、字段名不同）。
12. **legacy actor-only item 如何 fail closed？** 唯一精确显示名 ⇒ 可解析；
    歧义/非法/无法解析 ⇒ UNKNOWN ⇒ not mine（不注入）；队列内条目的最终处置取决于"会话作用域"决策。
13. **未来需要新增 canonical actor field 吗？** 需要（仅 runtime 对象层）。
14. **最合适字段名？为什么？** `actorId`——P25/P26 已用该名表示 canonical actor
    （`autonomy-core` / `diary-authority` / `domain-event-core` / `agent-orchestration-core`），
    且 workspace 条目不是 chat message（故不选 `speakerId`）。
15. **runtime enrichment 还是 schema change？** runtime enrichment（A）。
16. **需要 DB migration 吗？** 不需要。
17. **需要 P24 identity contract change 吗？** 不需要。
18. **需要 memberTurnId change 吗？** 不需要。
19. **需要新 Authority 吗？** 不需要，且明确禁止。
20. **问题只存在于 Group 吗？** 不。队列是全局的（WORKSPACE_GLOBAL）；
    同名放大效应才是 GROUP_ONLY。
21. **1:1 Chat 是否受影响？** 受影响（探针 s2：1:1 消费了群聊产生的条目）；
    但 1:1 会话内部不存在同名歧义（一个会话一个角色）。
22. **跨 Browser / Node / Home Node 吗？** 不跨（浏览器模块态；projectFiles 浏览器 IndexedDB；
    Home Node 接管面不含 workspace store）。
23. **修复时哪些 production 文件真正需要改？** `workspace.js`（producer 主体）+
    `workspace/run.js`、`site-operations.js`（事件驱动 producer 透传）+
    `communication.js`（注入点/ filter）；是否含 `workspace/files.js` 取决于是否处理 persisted 语义。
24. **明确禁止改哪些？** `group-runtime-core.js`（P24 identity/memberTurnId/planner/targeting/recent）、
    P23 五核心、`core.js`（DB_VER/schema）、Memory、Middle Brain、各域 canonical writer、
    任何新 Authority/Manager/Bus/store。
25. **P29-0 的 degradation diagnostics 需要变化吗？** 不需要（§18：不同根因）。
26. **还有哪些 display identity 进入 semantic decision？** R1（本审计）、R2（未过滤消费者）、
    R3（图片队列无 actor）、R4（`lastModifiedBy` 参与改名判断）；
    R5/R6/R7/R8 为 DISPLAY_SAFE / LEGACY_SAFE。
27. **P29-1 后是否需要 P29-C Identity Closure？** 需要（范围收窄到 R1–R4；建议 R1–R3 并入 P29-2）。
28. **Workspace Actor Identity 是否 READY FOR IMPLEMENTATION？** 见 Status =
    PASS WITH NOTES — CONTRACT DECISION REQUIRED（最小片段就绪，3 项决策待冻结）。
29. **如果 READY，最小 implementation scope？** producer 保留 `actorId`（`_execWsOps` 单点）+
    reader canonical 比较 + legacy 规则 + display 文案/1:1 行为不变。
30. **如果 NOT READY，缺的具体决策？** ① 字段命名（`actorId`）确认；② 队列会话作用域（是否隔离）；
    ③ 未过滤消费者（1:1 / tool continuation）的处置；④ 图片回注是否纳入；
    ⑤ persisted `lastModifiedBy` 的语义面是否同期处理。

---

## 最终状态

**P29-1 State: PASS WITH NOTES — CONTRACT DECISION REQUIRED**

STOP。
