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

## Deferred

- **Relationship Consequences**：**Phase 4A（familiarity → 开场）已落地**；
  仍缺 **Phase 4B（trust / disclosure）** 与 **Phase 4C（affinity / 语气）**，
  设计候选见 Phase 4 审计文档，**未实现**。
- **M3 enforcement**：soft repetition 仍只观测；rewrite / retry / drop / stop / guidance 全部未开。
- **Cross-run Duplicate S2**：跨 run 的重复判定尚未闭合。
- **尚未闭合的 RCI attribution**：`moments` / `role_letters` / `active.proactive` /
  `memory_consolidation` / `chat` group 分支 / `understanding` / `blog_comment`。
- **无 decay / 无 romance / jealousy / conflict simulation / 无 social graph / 无 DB migration**：
  全部**未实现**，且不属于本文档的承诺范围。任何一项都需要单独决策。

---

*本文只记录已被 production code 与 targeted tests 证明的事实。凡"以后可能做"的内容不进正文。*
