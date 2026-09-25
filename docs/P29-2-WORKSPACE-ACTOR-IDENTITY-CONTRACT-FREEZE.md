# P29-2 · Workspace Actor Identity Contract Freeze
## Minimal Attribution Fix Decision Stage

阶段性质：**CONTRACT DECISION / IMPLEMENTATION PLANNING / AUDIT-FIRST /
NO PRODUCTION CHANGE / NO CODE MODIFICATION / NO STAGE / NO COMMIT**。

本阶段**不写代码、不改 production、不 commit**；唯一制品 = 本文档（决策冻结）。
上游：`docs/P29-1-WORKSPACE-ACTOR-IDENTITY-AUDIT.md`（PASS WITH NOTES — CONTRACT DECISION REQUIRED）。

---

## 0. Upstream facts（复核后确认）

| # | 事实 | 复核证据 |
|---|---|---|
| 1 | Workspace `actor` = **display label**（非 canonical） | P29-1 §6/§9；`workspace.js:323/436/388…` 全部写 `actor: authorName` |
| 2 | canonical identity 在 producer 侧已存在（`cfg.id`） | 每个 `_execWsOps` 生产调用点都传 `cfg`（`communication.js:2689/3144/3256/4455`、`workspace.js:1048`） |
| 3 | 丢失点 = 写 runtime item 时 | `_gInjMine` 只能看到 `actor`（显示名） |
| 4 | 风险 = same-display-name collision ⇒ PROMPT_VISIBILITY contamination | P29-1 §9 探针（`{A:true,B:true}`、`modelA_sawB_feedback=true`） |
| 5 | 不需要 DB migration / P24 change / memberTurnId change / Authority / Event Bus / 新 store | P29-1 §20/§21/§27 |

### 0.1 对 P29-1 的一处更正（审计诚实性）

P29-1 §3 把 `workspace.js:657 _processWsResponse` 列为生产通用路径；**实际它没有生产调用者**：

* 定义 `workspace.js:653`，仅被 `window._processWsResponse`（`:1474`）与 `NS.workspace._processWsResponse`
  （`:1524`）导出，生产代码零调用；
* 调用者只有测试/诊断（`tests/test_image_router_smoke.js:195`、`tests/test_moments_phase4_smoke.js:353/356/443/449`）。

⇒ 生产 producer 面是 **5 个 `_execWsOps` 调用点**（群聊 / 1:1 流式 / 1:1 非流式 / 工具续轮 / `continueTruncatedMsg`），
`_processWsResponse` 属测试面（本阶段不改它，但实现时必须让它继续工作 —— 见 §8 的测试契约）。

### 0.2 P29-1 未记录、但影响契约的额外消费者

队列条目不止被 4 个注入函数消费，还有**与 actor 无关**的两类读者（全部只读 length / text）：

| 消费者 | 位置 | 读什么 | 与本次契约的关系 |
|---|---|---|---|
| workspace 指令需求信号 | `assets/js/chat-context-signals.js:42-44` | 三个队列的 `.length` | 只判"有没有"，不看 actor ⇒ 加 `actorId` 无影响 |
| 图像意图信号 | `assets/js/chat-context-signals.js:151-153` | `_wsPendingOpFeedback[i].text` | 同上 |
| 「待注入读取」UI 提示 | `communication.js:2726/2738`（群）· `3168/3374`（1:1） | `_wsPendingReads.length` | 同上（显示层；外来条目也会点亮提示 —— 属已记录风险） |

⇒ 新增字段是**纯增量**：这些读者不受影响，也不得被要求做归属判断。

---

## 1. Decision A — `actorId` field

**冻结提案**：

```js
// Workspace runtime item（四条队列统一）
{ actor: "希儿",        // DISPLAY ONLY（文案原样，UI 不变）
  actorId: "friend_x",  // CANONICAL ATTRIBUTION ID（= cfg.id；缺失/空 ⇒ 走 legacy 规则）
  … }                   // 其余字段不变
```

### Q1 · 是否违反已有字段语义？

**不违反。** 逐条证据：

1. `actorId` 在本仓库的既有语义**就是**"canonical 角色/模块 id"：
   `autonomy-core.js:113`（`missing-actor-id`/`bad-actor-id`，且 `:90` 明确拒绝 `group_` 前缀）、
   `diary-authority.js:93`、`active-message-authority.js:100`、`moments-mutation-authority.js:98`、
   `domain-event-core.js`（ALLOWED_FIELDS 含 `actorId`）、`agent-orchestration-core.js:132`。
   ⇒ 新增字段的**含义与既有词汇一致**，是复用而非重定义。
2. 这四条队列条目的现有契约只有 `{actor, text}` / `{path,…,actor,…}` / `{actor, images, text}`；
   没有任何消费者读 `actorId`（`rg -c actorId` 在 `workspace.js` / `workspace/files.js` /
   `workspace/run.js` / `site-operations.js` / `communication.js` 全为 **0**）⇒ 加键不会与既有读取冲突。
3. **需要显式冻结的词汇冲突**：`agent-orchestration-core.js:145` 的 `actor` 是**对象**
   `{ id: … }`，而 workspace 的 `actor` 是**字符串显示名**。冻结条文（§5）规定：
   *workspace 语境下 `actor` 一律是显示名；任何 canonical 判断只准看 `actorId`。*

### Q2 · 是否存在已有字段可以复用？

逐候选判定（值域相同≠词汇合适）：

| 候选 | 仓库既有语义 | 是否复用 | 理由 |
|---|---|---|---|
| **`actorId`** | P25/P26 的 **canonical actor id**（动作/事件/裁决的发起者） | **采用** | 语义完全一致；workspace 条目正是"谁执行了这个 op"的 attribution 对象 |
| `speakerId` | **chat message** 的作者身份（`metadata.speakerId`，P24-M2 契约字段） | 否 | workspace 条目不是消息；沿用会把 P24 消息契约语义搬进 runtime 队列（语义混用） |
| `roleId` | **域 store** 的角色键（moments / activities / diary / roleLetters 记录字段） | 否 | 取值同域，但名字绑定"域记录字段"；workspace 是跨域工具面 |
| `configId` | **P23/交付层**的 apiConfigs 键（`delivery-sequence-core` 选项 → `metadata.config_id`） | 否（次优） | 取值与 `cfg.id` 相同，但它表达的是"**provider 配置**身份"；角色身份与配置身份概念上可分离（`archivedConfigs` 已存在），用它会引入错误联想 |
| `friendId` | **会话目标**键（群聊时为 `group_*`） | 否 | 完全不同的 identity 域（收件方，不是发起方） |
| `ownerId` | **Economy** 的 user principal 归属（`services/home-node/economy-*`） | 否 | 域不匹配，且 producer 当场拿不到 |

⇒ **采用 `actorId`**（复用既有 canonical 词汇），不新造名字、不用 UUID。

### Q3 · 为什么必须新增？

因为这四条 runtime item **当前一个 canonical 字段都没有**（P29-1 §6 探针：`canonicalKeys=[]`），
而**不能**从 `actor`（显示名）安全反推：同名两个角色时反推必然二义（探针 `{A:true,B:true}`）。
唯一安全的做法是在 producer 端**当场保留**已有身份（`cfg.id`）——这正是 P29-1 §13 冻结的
"identity should be preserved, not reconstructed later"。

### Q4 · 类别

**A · runtime enrichment。**

理由：四条队列都是内存态（`workspace/files.js:4,6`、`workspace/run.js:12`、`site-operations.js:237`），
全仓库无任何 `dbPut`/`localStorage` 写入它们（P29-1 §7）⇒ 不触持久化、不触 schema，
**不是 B（internal contract change）也不是 C（persistence schema change）**。

---

## 2. Decision B — Reader strategy

### 方案 1（只修 attribution，保持 take-all）— **采用**

```
item.actorId 存在且非空 ⇒ 与当前 speaker 的 canonical id 比较（cfg.id）
item.actorId 缺失/空   ⇒ legacy：M2 resolver 语义
                          · 唯一精确显示名匹配 ⇒ mine
                          · 歧义 / 非法 / 无法解析 ⇒ not mine（fail closed）
注入点：只改今天**已有 filter** 的地方（群聊 _gInjMine）
其余注入点（1:1 / 工具续轮）**保持 take-all**
未归属（actor 与 actorId 都为空，如熔断条目）⇒ 保持既有"本轮首个发言者兜底消费"
```

### 方案 2（同时加 session scope）

```
workspace queue item ⇒ + conversation ownership（friendId/threadId 或 conversationId）
                      ⇒ 每个注入点先按会话过滤
```

### Q5 · 方案 1 是否已解决 P29-1 主缺陷？

**是（主缺陷 = 同名归属错配）。** 判据：

| P29-1 观察 | 方案 1 之后 |
|---|---|
| `{A:true,B:true}`（同名同时匹配） | A/B 的 `actorId` 不同 ⇒ 只有真正 owner 匹配 |
| `modelA_sawB_feedback=true` | 不再发生（A 的 `actorId≠B`） |
| `modelB_saw_own_feedback=false` | B 能拿到自己的条目（不再被 A 抢先消费） |
| legacy `actor`-only 同名条目 | 歧义 ⇒ not mine（fail closed；正是 P29-1 §8 冻结的规则） |

### Q6 · 方案 1 剩余风险

1. **R2 未修**：1:1（`communication.js:1724`）与工具续轮（`:4417`）仍是 take-all ⇒
   群聊产生的条目仍可能被**别的会话/角色**消费（P29-1 §9 探针 s2 已实证）。
2. **legacy 歧义条目的归宿**：同名 legacy 条目在群聊里不再被任何人消费（fail closed 的代价），
   会滞留在队列中，直到某个 **take-all** 消费者（1:1 / 工具续轮）把它取走 —— 这是方案 1 的
   已知不完美点（不是新引入的错，而是把"错给"换成"暂时不给"）。
3. **图片回注**（Decision C）与 **UI 提示**（§0.2）仍按 length 消费，不看归属（显示层影响）。
4. **R4**（`projectFiles.lastModifiedBy`，Decision D）仍是 persisted display 语义。

### Q7 · 方案 2 是否引入新的 identity/session contract？

**是。** 它需要：① 队列条目新增**会话归属**维度；② 每个注入点都增加会话过滤；③ 为
"无归属 legacy 条目"定义处置（丢弃 / 兜底 / 迁移）。这是**新的 session-scope 契约**，
不是 runtime enrichment —— 与 P29-1 §20 的 A 类（唯一必要项）不同。

### Q8 · 方案 2 是否超出最小修复范围？

**是。** 最小修复只要求"不让错误角色拿到不属于它的 result"（= attribution）；
方案 2 解决的是"队列要不要按会话隔离"（= 一个新的运行时所有权维度）。

### Q9 · 当前是否存在真实产品需求要求跨会话隔离？

**没有证据。** 仓库里没有消费者/UI/需求提出"workspace 队列必须按会话隔离"；
P29-1 只是**发现**了跨会话泄漏（缺陷事实），并未证明产品需要会话级契约。
⇒ 按"没有证据不要扩展"，**不在 P29-2/29-3 引入 session scope**；
R2 记录为 **P29-C follow-up**（并附上"若采纳，需要的契约与兼容后果"）。

> 备注（供未来决策）：若 R2 被判定必须修，最小形态其实是把**同一条归属规则**应用到
> 全部注入点（"take-all" → "take mine"），它**不需要**会话字段；但会改变
> "1:1 消费外来 legacy 条目"的现有行为（与 §7 的 `1:1 行为不变` 冲突），
> 因此它同样需要一个**显式的产品/契约决策**，不能在 P29-3 顺手做。

---

## 3. Decision C — Image drain

### 现状（复核）

| 项 | 证据 |
|---|---|
| `_ibImageDrain` 声明 | `site-operations.js:239`（**裸 dataUrl 字符串数组**，无任何身份字段） |
| 生产者（真实） | `workspace.js:390`（`ws_gen_image`）· `workspace.js:462`（`ws_read_image`） |
| 消费者（无 filter） | `communication.js:2536`（群，`splice(0)`）· `:2950`（1:1）· `:4425`（工具续轮） |
| 上限 | 生产侧 `length<6` 才入队 |
| 视觉门控 | 三处消费都要求该成员支持视觉（`_gVisionOk` / `_visionOk` / `_vOk`） |
| 同族另一条队列 | `_ibToolDrainImages`（`site-operations.js:238`）由**已被 filter 选中**的工具结果派生（`:439`）⇒ 继承 R1/R2，不是独立缺陷 |
| 注释提及但**不存在**的生产者 | 注释说"朋友圈等来源"，全仓库没有对应 `_ibImageDrain.push` |

### Q10 · 是否与 workspace actor attribution 属同一根因？

**同一根因类别，不同修复面。** 根因同为"workspace 起源的 runtime 队列不带 canonical 归属"；
但图片队列连 `actor` 都没有（不是"只存显示名"，而是"什么都不存"），
且条目形状是裸字符串 ⇒ 修复形态是**形状变更**，不是加一个键。

### Q11 · 是否也需要 actorId？

**需要（原则相同）**，但形态为 `{ dataUrl, actorId }`（+ 可选 `actor` 供诊断），
并连带 `_ibToolDrainImages` 一起决定；这属于 §20 的 B 类（internal contract change），
不是 A 类。

### Q12 · 如果纳入，需要改哪些文件？

`workspace.js`（390/462 两处 push）· `site-operations.js`（239 声明、480 live 暴露、
439 `_ibToolDrainImages` 派生）· `communication.js`（2534/2948/2536/2950/4425 消费点）。

### Q13 · 决定

**不纳入本阶段修复；记录为 P29-C follow-up。**
理由：① 形状变更（4 个生产文件 + 6 个消费/派生点）；② 视觉门控使其只在部分成员上可见，
危害面小于文本队列；③ 它不是修复 R1（同名归属）的必要条件；④ 本阶段禁止顺手扩大范围。

---

## 4. Decision D — `projectFiles.lastModifiedBy`

### 现状（复核）

| 角色 | 位置 | 内容 |
|---|---|---|
| 写入 | `workspace/files.js:108/115/174`（`wsSaveFile` / `wsEditFileContent` 的 `author`） | `lastModifiedBy = author || 'AI'`（**display 名**） |
| 复制 | `workspace/files.js:1198` | 重命名/复制时原样带过去 |
| 显示 | `workspace/files.js:996` | 文件 meta 行（`'你'→'User'` 展示映射） |
| **语义** | **`workspace.js:32`** | `lastModifiedBy==='User' \|\| ==='你' \|\| ==='导入'` ⇒ `_wsUniquePath()`（**改名避让，不覆盖**） |

### Q14 · 是否参与 semantic decision？

**是**（`workspace.js:32` 决定"覆盖还是另存新名"）。

分类：**ATTRIBUTION（持久化）+ ROUTING（保护性改名）**；
**不是 PERMISSION**（不决定谁能读写）；也不是严格的 OWNERSHIP（没有所有者/权限语义，
但它保护用户手改内容这一动作带保护性质）。

### Q15 · 显示名存储是否会造成实际错误？

**窄但真实，且与同名无关：**

* 判据只对**保留标签** `'User'` / `'你'` / `'导入'` 生效 ⇒ AI 之间同名（两个"希儿"）
  **不会**触发这个分支（AI 名字都不在保留标签里）⇒ **同名不会造成该错误**；
* 真正的风险是**保留标签碰撞**：若有角色昵称恰好是 `你` / `User` / `导入`，
  它写的文件会被当成"用户手改"⇒ 该 AI 后续重写会被改名而不是覆盖，且 UI 会把它显示成 `User`；
* 未发现该碰撞在现存数据中发生的证据（无相关测试/日志/报告）。

### Q16 · 是否属于同一个 actor identity contract？

**同一根因（`author` 显示名从同一个 producer 流出），不同契约面（persisted 文件元数据 + 写保护规则 + UI）。**
本阶段**不纳入**（它不是 runtime enrichment；若处理需同时冻结"用户 principal 标记"这一持久化语义），
记录为 **P29-C follow-up**。

---

## 5. Canonical Identity Vocabulary（统一术语）

**冻结（禁止再出现 `workspace actor = canonical` 的说法）：**

| 层 | 术语 | 语义 | 允许用途 | 禁止用途 |
|---|---|---|---|---|
| display identity | `actor` · `nickname` · `displayName` · `senderName` · `lastModifiedBy` | 人类可读名字 | UI / 文案 / 转录 / 文件 meta 显示 / legacy 唯一精确匹配 | 任何 semantic decision（"是不是我的"/"属于谁"/"注入给谁"/"谁能看到"/"路由给谁"） |
| canonical identity | **`actorId`（本阶段冻结名）** · `cfg.id` / `apiConfigs.id` · `speakerId`（= 同一 domain，chat message 用）· `roleId`（域记录用） | 稳定 id | attribution / ownership / SELF 判断 / 路由 | 展示 |
| 特殊 | `'User'` / `'你'` / `'导入'` | **保留显示标签**（用户侧写入者） | 显示 + 既有的导入避让规则 | 不得被 AI 角色昵称占用（已知风险，见 Q15） |

### Q17 · Workspace 最终是否应遵循 P24/M2 相同原则？

**是。** 冻结为与 M2 同一条原则：

```
identity first, display second
canonical identity 存在 ⇒ canonical wins
canonical 缺失        ⇒ legacy 唯一精确显示名
歧义 / 非法 / 无解析  ⇒ UNKNOWN（not mine）
```

workspace 是该原则的**第三个适用面**（前两个：chat message 身份 P24-M2；撤回 ownership P29-0）。

---

## 6. Producer Change Boundary（确认）

**允许修改（未来 implementation）**：`assets/js/workspace.js` · `assets/js/workspace/run.js` ·
`assets/js/site-operations.js` · `assets/js/communication.js` 的 injection seam。

**禁止**：`assets/js/group-runtime-core.js`（P24 identity / planner / targeting / recent / memberTurnId）·
P23 五核心 · `autonomy-core.js` / Autonomy · `middle-brain*.js` · `memory.js` ·
DB 层（`core.js` 的 `DB_VER`/schema）· 任何新 Authority / Manager / Bus / store / 第二身份。

**确认无误**：本阶段（P29-2）**不修改以上任何文件**（含允许清单）。

---

## 7. Compatibility Contract（冻结）

| 必须保持 | 在方案 1 下是否可保持 | 说明 |
|---|---|---|
| display 文案不变 | **是** | `actor` 仍作为文本源；注入文案、文件 meta、拍一拍/撤回文案都不动 |
| workspace UI 不变 | **是** | 不碰 `files.js` 渲染、不碰卡片 |
| 1:1 行为不变 | **是** | 1:1 注入点保持 take-all（决策 B 方案 1） |
| group planner 不变 | **是** | 不碰 `group-runtime-core.js` |
| targeting 不变 | **是** | 不碰 `targetSpeakerIds` |
| recent 不变 | **是** | 不碰 `recentSpeakerIds` |
| memberTurnId 不变 | **是** | 不碰身份派生 |
| P23 不变 | **是** | 五核心零引用 |
| canonical writers 不变 | **是** | 只加 runtime 字段；`projectFiles`/`chatMessages` 写入者不变 |

### Q18 · 是否全部可保持？

**是（全部可保持）**，但必须显式记录**唯一的意图行为变化**（它不是兼容性破坏，而是缺陷修复本身）：

> 群聊中 **legacy（无 `actorId`）且显示名歧义** 的 workspace 条目，从此**不再**被误解给某个同名成员；
> 它变成 not-mine（fail closed），可能滞留到 take-all 消费者为止（§Q6-2）。
> 唯一名称的 legacy 条目行为**不变**；无 actor 的条目（熔断）行为**不变**（首轮兜底）。

---

## 8. Test Contract（未来实现必须具备）

| 组 | 断言 |
|---|---|
| Producer | 四类 workspace item（read / op-feedback / run-output / tool-result）均带 `actorId = cfg.id`；`_wsCheckPhantom` / `_rCtx` / `_ibExecToolOp` 三条透传路径同样带上 |
| Producer 边界 | `cfg` 不是对象（如测试里传字符串 `'p4a-json'`）⇒ `actorId` 为空字符串（**不得抛错**），reader 走 legacy 路径 |
| Reader | 同名 A/B：各自只消费自己的条目（复用 P29-1 §9 探针 fixture，断言 `modelA_sawB_feedback=false` 且 `modelB_saw_own_feedback=true`） |
| Legacy | `actor`-only 唯一名 ⇒ 可注入；`actor`-only 同名歧义 ⇒ **不注入**（fail closed） |
| 无归属 | `actor===''` 且无 `actorId`（熔断条目）⇒ 保持既有首轮兜底行为 |
| 兼容 | `test_workspace_smoke.js`（`:257` 未过滤注入路径）· `test_identity_read_path_closure.js` · `test_group_speaker_identity.js` · `test_group_turn_identity.js` 全绿 |
| 诊断面 | `test_image_router_smoke.js` / `test_moments_phase4_smoke.js` 走 `_processWsResponse`（测试面入口）仍工作 |

**不跑 full quick。**

---

## 9. Final Implementation Decision

```
## P29-2 Workspace Actor Identity Decision

Decision:

ADOPT

Implementation scope:

Workspace Actor Canonical Attribution（最小修复，P29-3 执行）：
  1. producer 保留 canonical identity：`_execWsOps` 写入四条队列时带 `actorId = (cfg&&cfg.id)||''`；
     三条事件驱动生产者（`_wsCheckPhantom` / `_rCtx`(run) / `_ibExecToolOp`）同步透传；
  2. reader 只改今天已有 filter 的注入点（群聊 `_gInjMine`）：canonical 比较 + legacy 规则 + 歧义 fail closed；
  3. display 文案 / workspace UI / 1:1 take-all / 无归属兜底 全部不变；
  4. 明确排除：session scope（方案 2）、image drain、projectFiles.lastModifiedBy —— 三者均记为 P29-C follow-up。

Contract changes:

A · Runtime object enrichment only（workspace runtime item 增加 actorId）
  · 无持久化、无 schema、无 P24 改动、无新 Authority/Manager/Bus/store
  · 术语冻结见 §5（actor = display only；actorId = canonical attribution identity）

Fields:

{ actor: <display name>, actorId: <cfg.id or ''>, …其余不变 }

Producer files:

assets/js/workspace.js（_execWsOps + 四条队列 push + _wsCheckPhantom + _rCtx）
assets/js/workspace/run.js（_wsPendingRunOutputs 透传 actorId）
assets/js/site-operations.js（_ibExecToolOp / _ibQueueToolResult 透传 actorId）

Reader files:

assets/js/communication.js（仅群聊 filter `_gInjMine` 一处；其余注入点不动）

Legacy behavior:

actorId 存在且非空 ⇒ canonical 比较；
actorId 缺失/空 + actor 非空 ⇒ M2 resolver 语义（唯一精确显示名；歧义/非法 ⇒ not mine）；
actor 与 actorId 都为空 ⇒ 保持既有"本轮首个发言者兜底消费"。

Tests:

见 §8（producer / reader same-name / legacy unique+ambiguous / 无归属 / 四个回归套件 / 测试面入口）
```

---

## 10. Required final answers

| # | 问题 | 答案 |
|---|---|---|
| Q1 | `actorId` 是否需要？ | **需要**（P29-1 证明条目零 canonical 字段，且无法从显示名安全反推） |
| Q2 | `actorId` 字段名是否确定？ | **确定**（复用 P25/P26 canonical actor 词汇；`speakerId`/`roleId`/`configId`/`friendId`/`ownerId` 逐条排除，见 Q2 表） |
| Q3 | `actor` 是否降级为 display only？ | **是**（冻结条文见 §5；禁止 `workspace actor = canonical` 的用法） |
| Q4 | 是否修 `_gInjMine`？ | **是**（唯一 reader 改动点；canonical 比较 + legacy 回退 + 歧义 fail closed） |
| Q5 | 是否保持 take-all？ | **保持**（1:1 与工具续轮注入点不改；`1:1 行为不变` 是 §7 的冻结项） |
| Q6 | 是否引入 session scope？ | **不引入**（无产品需求证据；记为 P29-C follow-up） |
| Q7 | 是否纳入 image drain？ | **不纳入**（A 类之外；形状变更；记为 P29-C follow-up） |
| Q8 | 是否纳入 `projectFiles`？ | **不纳入**（persisted 语义 + 保留标签问题；记为 P29-C follow-up） |
| Q9 | 是否需要 P24 change？ | **不需要**（复用同 domain 的 `cfg.id`） |
| Q10 | 是否需要 DB migration？ | **不需要**（runtime enrichment；队列 runtime-only） |
| Q11 | 最小 implementation scope？ | 见 §9：producer 1 点 + 3 条透传 + reader 1 点 + 兼容保持；不动 1:1/session/图片/文件元数据 |
| Q12 | P29-2 后是否进入 P29-3 implementation？ | **是**（本阶段已冻结全部必要决策：字段名、reader 规则、范围边界、兼容项、测试契约） |

---

## Final State

**P29-2 State: PASS — IMPLEMENTATION APPROVED**

STOP（本阶段不改 production、不 commit；P29-3 才实施）。
