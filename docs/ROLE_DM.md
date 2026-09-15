# Role DM（角色私信）

> 本文是 **角色私信（Role DM）** 的 canonical overview：当前稳定能力、真实调用路径、
> 隐私边界、关系三维、自主发起、质量/安全层、可观测性，以及**明确 deferred** 的部分。
> 关联：[ARCHITECTURE.md](ARCHITECTURE.md)（全局架构）· [DECISIONS.md](DECISIONS.md)（D13 / D24 / D25 / D26）·
> [SOCIAL_RUNTIME.md](SOCIAL_RUNTIME.md)（社会闭环）· [ROLE_DM_RELATIONSHIP_PHASE4_AUDIT.md](ROLE_DM_RELATIONSHIP_PHASE4_AUDIT.md)（关系后果只读审计）。
>
> 纪律：**本文只写已经被 production code / targeted tests / 已提交 decision 证明的事实。**
> 凡未实现或未闭合者，一律进入 §Deferred，不写进"已实现"。

## Status

**已实现且稳定**（每项均有生产代码 + 测试证据）：

- **持久角色 ↔ 角色私信**：一对角色一个 thread，消息落在既有 `chatMessages` store
  （`byFriend` 索引，不新增 store、不升 DB_VER —— `role-dm.js:79`、`loadMessages` `:439`）；
  thread / 关系 / 账目 / 偏好四份索引在 localStorage（`ib_role_dm_threads_v1` `:84`、
  `ib_role_dm_relations_v1` `:85`、`ib_role_dm_ledger_v1` `:86`、`ib_role_dm_prefs_v1` `:87`）。
- **五层独立上下文**（Self / Peer / Relationship / Shared Past / Recent —— `role-dm-core.js:1032-1041`）。
- **Public Profile / Peer Awareness**：对方认知唯一来自 `public-profile-core.js` 的
  `buildPeerView()`（构造式白名单，`role-dm.js:466-475`、`:493-514`）。
- **跨 run Thread Memorandum**：一对角色一份、**无向**、watermark 推进，
  由 `role-dm-core.js` 的 `memorandumEligible/memorandumFoldLines` 纯函数生成
  （`role-dm.js:1270-1298`）。
- **自主社会意图（autonomous social intent）**：opt-in、硬预算、挂在既有 `_activeTick` 上
  （无第二个 `setInterval`）。
- **输出类失败分类**：`output-truncated` / `empty-output` 是正式停止原因（D25），
  manual 与 autonomous 同码。
- **S1 低信息归一化闭合**：低信息短句在匹配前归一（`cadd7ed`），authority 属既有 low-info guard。
- **M3 软复读 = 纯观测**（`role-dm.js:1073-1086`；`role-dm-core.js:659-696`）。
- **RCI 身份可观测**：`consumer` / `characterId` / `threadId`（D26），Role DM 与 Diary 角色归因已闭合。
- **familiarity → 开场行为后果（Phase 4A）**：`role-dm-core.js` 的
  `buildFamiliarityGuidance(familiarity)` 把熟悉度投影成一句**相处方式**指导
  （【相处方式】），三档复用既有词表阈值（0.2 / 0.7），并**在结构上**只吃 familiarity
  这一个数 —— 因此它**永远不能**授权"我们具体经历过什么"。manual 与 autonomous 共用同一 seam。

**Deferred**（见文末 §Deferred）：Phase 4B（trust / disclosure）、Phase 4C（affinity / 语气）、
M3 enforcement、Cross-run Duplicate S2、尚未闭合的 consumer 归因。

## Architecture

真实数据流（每一跳都有代码位置；**不含**任何未实现的路径）：

```
Public Profile（角色配置的 publicProfile 字段）
      ↓  public-profile-core.buildPeerView()   ← 构造式白名单
Peer View（name / publicIntro / occupation / traits / interests）
      ↓
Role DM Context   （role-dm-core.buildRoleDmContext，五层各自成块、绝不互写）
 ├ ① SELF         自 persona + 对用户的关系（cfg.relationship，原义保留）
 ├ ② PEER         对方公开资料（buildPeerView）
 ├ ③ RELATIONSHIP 有向关系记录 → describeRelation() 的一句话
 ├ ④ SHARED PAST  threadMemorandum（无向、一对角色一份）
 └ ⑤ RECENT       本 thread 最近 12 条原文
      ↓
role_dm execution（role-dm.js runTurn → callApiChat，预算 2048 / 重试 4096×1）
      ↓
messages（chatMessages） / relationship（observeRun） / memorandum（updateMemorandum）
      ↓
optional autonomous social intent（role-dm-social-core.evaluateSocialIntent
                                   ← role-dm-social.js 组装候选与预算）
```

- **一次 run 的编排**：`runTurn`（`role-dm.js:642`）→ `composeSide`（`:476`，逐侧组装）
  → 一次模型调用 → `observeRun`（`:1218`，写关系）→ `updateMemorandum`（`:1263` 起）。
- **有向 vs 无向**：③ 是**有向**的（A→B 与 B→A 各一条记录），④ 是**无向**的
  （A 与 B 必然读到同一份）。两者刻意不合并 —— 合并会让 A/B 各自"看到"不同的共同历史
  （`role-dm-core.js:1043-1059`）。
- **manual / autonomous 共用**：同一条 `runTurn`、同一份上下文组装、同一套停止原因词表；
  差别只在 `trigger`（`'manual'` / `'autonomous'`）与是否带 `signal`（自主理由 code）。

## Privacy Boundary

**SELF（本侧可见）**

- 自己的 persona（`selfSystemPrompt`）
- 自己的 private Memory / Understanding / Middle Brain private state（不经本域转手给对方）

**PEER（本侧可读到对方的）**

- `publicProfile`（bio / 身份 / 特征 / 兴趣，经 `buildPeerView()` 白名单投影）
- **有向**关系记录（本侧 → 对方那一条；方向绝不错用）
- 共享会话上下文：本 thread 的历史、thread memorandum

**NEVER PEER（结构上就到不了对方）**

- 对方的 `systemPrompt` / persona 原文 —— 不做 `slice()` 截取，理由：截取长度是任意选择，
  秘密设定 / OOC 指令一旦被截进去就是无法回滚的泄漏（`role-dm.js:472-475`）
- API key / endpoint / 凭据
- 对方的 private Memory、private Understanding、private Middle Brain state
- 对方的 `relationship` **字段**（那是"角色对用户"，不是"角色间"；`role-dm.js:499-501`）

关系块里**没有**公开资料，公开资料里**没有**关系字段（`role-dm-core.js:1055-1057`）。

## Relationship

当前**真实存在**的维度只有三个（`role-dm-core.js:181` `RELATION_DEFAULT = {trust:0.5, familiarity:0.2, affinity:0.5}`）：

| 维度 | 初值 | 谁在写 | 怎么变（`relationDelta`，`role-dm-core.js:501-520`） |
|---|---|---|---|
| `trust` | 0.5 | `role-dm.js observeDirection`（每个 run 每方向一次） | **只由净正语气驱动**；净 ≤ 0 一律 0 |
| `affinity` | 0.5 | 同上 | 同 `trust` 的驱动 × 0.8 |
| `familiarity` | 0.2 | 同上 | **只由"确实聊过几轮"驱动**（`0.004 × turns`），与语气无关 |

- **中性闲聊不增加 `trust` / `affinity`**：净正才驱动，绝不用"没检测到负面"当"正面"
  （`role-dm-core.js:495-500`）。
- **`familiarity` 可以由实际交谈增加**（可观察事实，不可伪造）。
- **单次 run 的改动被 `RELATION_DELTA_CAP = 0.03` 硬顶**，各维度独立、方向独立
  （`role-dm-core.js:185,521-526`；`role-dm.js:1216-1217`）。
- **当前真正影响行为的只有三处**：
  ① ③ 层里的一句话（`describeRelation`，只讲 `trust` / `familiarity`，**不讲 `affinity`**；
  `dmCount = 0` 时整句不注入）；
  ② 自主发起的评分信号（`familiarity` 权重最大 0.36）；
  ③ **Phase 4A：`familiarity` 的开场行为投影**（【相处方式】，见下）。
- **Phase 4A 的边界（authority 分离，且是结构性的）**：

  | authority | 授权什么 | 不授权什么 |
  |---|---|---|
  | `familiarity`（stance） | 「我们有多熟」→ 开场要不要像初次见面 | **绝不**授权具体共同经历 |
  | history / thread memorandum | 「我们具体经历过什么」（事实） | 不改变关系强度 |
  | publicProfile | 「TA 是谁」 | 不携带关系 |
  | self persona | 「我是谁」 | 不被关系改写 |

  `buildFamiliarityGuidance` 的**唯一输入**是 familiarity 数值，因此它拿不到备忘/历史/
  公开资料/persona —— 这条边界是**函数签名**保证的，不是注释纪律；测试 AF1 直接钉住元数。
- **仍然没有的**：`familiarity` **未**控制 disclosure（不决定"能说什么私事"）、
  **未**控制语气，**未**成为 initiative 的硬路由；`affinity` 仍对模型不可见。
  Phase 4B / 4C 见 §Deferred。
- 完整取证见 [ROLE_DM_RELATIONSHIP_PHASE4_AUDIT.md](ROLE_DM_RELATIONSHIP_PHASE4_AUDIT.md)。
- **无 decay**：三个维度都不是衰减型；`trust` / `affinity` / `familiarity` 是**单向棘轮**
  （净 ≤ 0 记 0，不记负）。

## Autonomous

- **opt-in**：全局与角色级都需开启（`BLOCK.disabled`，`role-dm-social-core.js:458`）。
- **manual / autonomous 共用**：同一条 run 路径；自主只是 `trigger='autonomous'`。
- **硬闸门（顺序即优先级，`role-dm-social-core.js:457-475`）**：disabled → quietHours →
  backoff → 用户 10 分钟内活跃 → 角色不存在/忙 → 日额（角色级 / 全局级）。
- **硬预算（`BUDGET`，`:170-176`）**：角色 2 次/日、全局 6 次/日、
  同一对角色冷却 6–9h（`6h + hash 分档`，`:211-216`）、失败退避 4h 起、上限 24h。
  自主上限**严格小于** manual 上限（manual 为 `ROLE_DAILY_TURN_MAX = 40` 轮/日，
  `role-dm-core.js:64`）。
- **调度**：挂在既有 `_activeTick` 上，全局 gate 150s、评估间隔 45–90min
  （`SCHED`，`:179-183`）；**不新增**第二个 `setInterval`（测试 S15 钉住）。
- **决策输出只有 `initiate` / `no-action`**（`:412`），并且 `noAction` 会如实带出
  `blockers` / `reasonCodes` / `nearMiss`（"差多少"必须能被看出来，`:511-517`）。
- **陌生人政策**：完全陌生默认**不参与打分**（不是"分数低"，而是候选不存在，`:317-324`）；
  `allowStrangers` 打开的是"允许考虑"，不是"开始刷陌生人"（关系分量为零，`:325-327`）。
- **不扩大 signal 集**：`SIGNAL_WEIGHTS` 六项（`existingThread / familiarity / affinity /
  trust / longTimeNoContact / sharedPast`，`:149-156`）+ 有界抖动 ≤0.06。
  抖动**永不可能**独自触发一次联系（单信号最低权重 0.30 > 0.06，`:144-147`）。
- 它**不是**"角色会随时自由聊天"：过线是必要条件，且还要过上面每一道闸门。

## Quality / Safety

| 机制 | 状态 | authority |
|---|---|---|
| hard duplicate（逐字重复） | 生效 | 既有 runaway guard |
| low-info 归一化（S1） | 生效（`cadd7ed`） | 既有 low-info guard |
| M3 soft repetition | **仅观测（OBSERVATION ONLY / DORMANT）** | `analyzeSoftRepetition`（纯函数） |
| 输出类失败（截断 / 空正文） | 生效，正式停止原因 | D24 / D25 |

- **M3 不执行任何 rewrite / retry / drop / stop / guidance**：`role-dm.js:1073-1086` 明确
  "只观测，不拦截"；判定的是"要不要在下一次**本来就会发生**的调用里带上提示"，
  因此**调用次数与 M3 之前逐字相同**（测试 AH2 / AH4 / AH9 / AH11 钉住）。
- **M3 弃权于既有 authority**：低信息短句归 low-info guard，截断/复读 runaway 归 runaway guard
  （`role-dm-core.js:659-696`）。
- **M3 观测不落盘、不留正文**（run 结束即消失，`role-dm.js:1082`）。
- **M3 enforcement 是 deferred**（见 §Deferred）：未开 rewrite/retry/drop/stop/guidance。

## Observability

`IBModelCore.reasoningTrace` 允许的身份三元组（D26）：

| 字段 | 含义 | Role DM 现状 |
|---|---|---|
| `consumer` | 谁发起的 | `'role_dm'`（显式声明，`role-dm.js:660`） |
| `characterId` | 真实执行上下文的角色 id | 发言方 id（`speakerId`，`:658-662`）**已闭合** |
| `threadId` | 会话/线程 id | `thread.threadId`（`:661`）**已闭合** |

- **Role DM attribution：已闭合**（双角色身份不串、预算重试身份不漂移，
  `tests/test_rci1_call_identity.js`）。
- **Diary character attribution：已闭合**（`20ad52f`，`tests/test_rci1_1_diary_identity.js`）。
- **Diary `threadId = ''` 是**有意设计**：Diary 没有会话线程概念，
  不为"看起来完整"制造假身份。
- **Middle Brain 已统一经过 reasoningTrace writer**：Role DM 的 trace 打点与调用共用同一条记录
  （`role-dm.js:654-673`；字段白名单 `_MB_TRACE_FIELDS` 未扩容，见 D25）。
- **尚未闭合 / 未核（deferred）**：`moments`、`role_letters`、`active.proactive`、
  `memory_consolidation` 仍未声明 `characterId`（trace 里仍为 `''`）；`chat` 的 group 分支与
  `understanding` / `blog_comment` 身份未核。
  **不得**把这些写成"已完成"。
- **trace 禁止** prompt / 正文 / API key / endpoint 等敏感内容；身份三键只驻内存、
  **绝不**进入 provider 请求体（D26）。

## Disclosure Classification（Phase 4B-1）

`assets/js/disclosure-core.js` 是「角色自我事实的披露等级」的**唯一**实现
（UMD 双载、零 IO、零模型调用、不读 trust / 不读关系 / 不读 persona / 不读 Memory）。
它建立的是**数据类型**，不是行为：**今天没有任何 prompt 读它**。

| 项 | 契约 |
|---|---|
| 四档（封闭枚举） | `PUBLIC` / `PERSONAL` / `PRIVATE` / `SECRET`，精确匹配，不做大小写/近似修正 |
| 第五个值 | `UNDETERMINED` = **未参与披露契约**（**不是**第五档敏感度；无 rank ⇒ 不可能被当成最低档放行） |
| record 形状 | 七个字段：`factId` / `ownerCharacterId` / `level` / `text` / `source` / `subjectCharacterId` / `updatedAt` |
| owner | **必须显式给出**，不从 `createdBy` / `visibleTo` / `subject` 推断；缺失 ⇒ 整条 `null` |
| provenance 上限 | **authored**（`character_authoring` / `user_authoring` / `user_correction`）→ 可持 SECRET；**其余一切**（`memory_extraction` / `role_dm_conversation` / `diary` / `consolidation` / `generated_inference` / `unknown`）→ **强制降为 PUBLIC** |
| legacy | 缺 / 非法 `level` ⇒ `UNDETERMINED` ⇒ `isDisclosureFact() === false`（**不进入**披露子系统；**不是**默认 PRIVATE，也**不是**默认 SECRET） |

**四条边界**（由代码结构保证，不是注释纪律）：

1. **`publicProfile` = PUBLIC BY CONSTRUCTION**（`public-profile-core.js` 的构造式白名单）。
   本契约**不是**它的公开权威：带 `publicIntro`/`occupation`/`traits`/`interests` 的
   `PUBLIC` 事实会被 `publicProfileWouldDoubleOwn` 直接**拒绝** —— 不制造第二份公开权威。
2. **`systemPrompt` = 身份权威，不是事实数据库**。带 `systemPrompt` / `persona` /
   `domain:'SELF_IDENTITY'` 的输入被**整体拒绝**（不是"删掉该字段再继续"）。
3. **`SHARED THREAD HISTORY != PRIVATE SELF DISCLOSURE`**。`memorandum` /
   `threadMemorandum` / thread history 是 A 与 B **共同**的经历，不是 A 的秘密；
   带这些键或 `domain:'SHARED_THREAD'` 的输入同样被拒绝。
4. **`USER_PRIVATE` / `SYSTEM_PRIVATE` 未获得任何新的 peer 可见路径**。
   `apiKey` / `endpoint` / `authorization` / `cookie` 等键进 `DENY_FIELDS`；
   本契约不读也不写任何生成这些数据的 store。

**方向性**（语义声明，**本轮不实现授权**）：未来唯一合法的读取形状是
`speaker = A, peer = B → A-owned facts + relationGet(A, B)`；
**排除** B-owned facts、`max(A→B, B→A)`、平均值。`ownedBy(fact, speakerId)` 与
`disclosureScope(speakerId, peerId, facts)` 只做归属整形，不返回"可否披露"。

**HARD vs SOFT（术语纪律，见 D26 / Phase 4B-0 审计）**：
`HARD DISCLOSURE BOUNDARY = 未授权内容从不进入模型上下文`；
`SOFT GUIDANCE = 模型看到内容，只是被要求别提`。本契约实现的是**前者的数据前提**，
**不是**前者本身 —— 前者需要 Phase 4B-2 的 authorization 阶段。

## Disclosure Writer Authority（Phase 4B-1.1）

回答的是**一个**问题：「谁有资格创建一条真正的 `PERSONAL` / `PRIVATE` / `SECRET`
disclosure fact？」结论：**不是通道，是权威**。

只读 writer 审计（`character` 编辑器 / Memory / Role DM / Diary / Understanding /
consolidation / publicProfile / Moments / Letters 全部写入路径，file:line 见 D29）
证明：**同一个通道既能承载人类显式写下的设定，也能承载模型自己生成的一句话**。
所以 `source` 单独决定等级上限是**不够**的：

```
用户显式写下   「设定：昔涟很怕打雷，这是她不愿告诉别人的事。」
模型在 Role DM 「我可能其实很怕打雷。」
              ↑ 两者可以经过同一个通道；只看通道在类型上就无法区分
```

因此契约分成**两个维度**，并互相印证：

| 维度 | 回答 | 取值 |
|---|---|---|
| `source` | 内容经过**哪条通道**产生（provenance） | 9 个封闭值（4B-1 冻结） |
| `authority` | **谁对"这是本角色的秘密"负责**（writer authority） | `human_authoring` / `human_confirmation` / `derived` |
| `authoredBy` | 该权威的**身份**（可选旁证，**不是**授权本身，见下） | 归一化后的 id 或 `''` |

| 项 | 契约 |
|---|---|
| 等级上限 | **只由 `authority` 决定**：人类权威 → 可持 SECRET；`derived` → 强制降为 PUBLIC。`source` **不再**单独决定上限 |
| 通道 ⇔ 权威 | 必须互相印证，**双向**都拒：非人类通道 + 人类权威（伪造）、人类通道 + 非人类权威（自相矛盾，含 `derived`）⇒ 整条拒绝 |
| 畸形 authority | 一律 → `derived`（fail closed 到"**没有人对它负责**"，而不是"不参与契约"） |
| `authoredBy` | 可选：derived 携带它 ⇒ **拒绝**（自相矛盾）；人类权威不要求它 —— 人类权威建立在**通道的结构性事实**上，纯函数里任何人都能写下 `authoredBy:'user'`，所以"必须实名"只是一道看起来像门的检查 |
| record 形状 | **九个**字段：4B-1 的七个 + `authority` / `authoredBy` |
| legacy 兼容 | 只给 `source`（4B-1 冻结形状 `{owner, level, text, source}`）时，authored 通道 → `human_authoring`、其余 → `derived`，**逐字保留** 4B-1 行为；归一化保持幂等 |
| 生产 writer | **零**。本轮只扩展契约，**没有任何代码产出 disclosure fact**（见 D29「为什么不是 C」） |

**`source` 与 `authority` 不是同一个维度** —— 一个描述**通道**，一个描述**责任**。
把它们重载进同一个字段，就等于让"内容经过了哪条管道"悄悄变成"谁授权了它"。

## Deferred

- **Relationship Consequences**：**Phase 4A（familiarity → 开场）已落地**；
  **Phase 4B-1（披露分级数据契约）已落地**（`assets/js/disclosure-core.js`，纯数据
  contract：分类 + provenance + 归一化；**不做授权、不接 Role DM**，见 D28）；
  **Phase 4B-1.1（writer authority）已落地**（同上 core：新增 `authority` /
  `authoredBy` 两维 + 通道交叉校验；**仍然零生产 writer、零消费者**，见 D29）；
  仍缺 **Phase 4B-2（authorization / filtering）** 与 **Phase 4C（affinity / 语气）**，
  设计候选见 Phase 4 审计文档与下节，**未实现**。
- **Disclosure authorization**：`disclosure-core.js` 里**刻意不存在**
  `authorize()` / `filter()` / `canDisclose()` —— 授权的输入（`speakerId` / `peerId` /
  有向关系）和输出（哪些事实能进模型上下文）都还没有实现，且 **`trust` 完全未接入**。
- **Disclosure candidate 流程（模型候选 → 人类确认）**：`human_confirmation` 的**语义**
  已在契约里，但 candidate 的产生、展示与确认**全部未实现**，也没有任何模型调用被接入。
- **Disclosure fact 的写入入口**：仓库里**没有任何**一个动作明确表示"用户正在创建
  一条披露事实"（character 编辑器写的是 `systemPrompt`/`publicProfile`，Memory 编辑器
  写的是 ACL）。因此本轮不接 writer —— 不是遗漏，是**证据不足**。
- **M3 enforcement**：soft repetition 仍只观测；rewrite / retry / drop / stop / guidance 全部未开。
- **Cross-run Duplicate S2**：跨 run 的重复判定尚未闭合。
- **尚未闭合的 RCI attribution**：`moments` / `role_letters` / `active.proactive` /
  `memory_consolidation` / `chat` group 分支 / `understanding` / `blog_comment`。
- **无 decay / 无 romance / jealousy / conflict simulation / 无 social graph / 无 DB migration**：
  全部**未实现**，且不属于本文档的承诺范围。任何一项都需要单独决策。

---

*本文只记录已被 production code 与 targeted tests 证明的事实。凡"以后可能做"的内容不进正文。*
