# P28-INTERJECT-AUDIT · Group Runtime INTERJECT 重新评估

阶段性质：**只读审计 / 契约缺口分析 / 决策门禁**。
**零 production 变更**：没有实现 `interjectEntry` / `resumeEntry` / `admissionPool`，没有 queue mutation，
没有 planner 修改，没有 DB migration，没有 Event Bus，没有 Autonomy 接入，没有 MB 接入。

上游冻结：

- `docs/P24-M3.5-DYNAMIC-PARTICIPATION.md` §M3.5.2D（INTERJECT contract only，**未实现**）；
- `docs/P28-1-AGENT-RUNTIME-BOUNDARY-FREEZE.md`（域运行时边界冻结）；
- `docs/P24-M3-PARTICIPATION-CONTRACT.md` §7（`groupOrder` = planned order）；
- `docs/P24-M2-SPEAKER-IDENTITY.md`（canonical `speakerId` = `apiConfigs.id`）。

---

## 0. 结论摘要（TL;DR）

| 问题 | 结论 |
|---|---|
| INTERJECT 属于哪一类？ | **A · Dynamic Participation Runtime Decision**（不是 Autonomy Action / 不是 Group Capability / 不是新 Domain Runtime primitive） |
| 今天有合法候选来源吗？ | **没有**。A 需要新契约；B/C/D/E 不合法（详见 Phase 2） |
| 今天有真实产品需求吗？ | **没有消费者、没有需求信号** ⇒ **REDUNDANT_CANDIDATE** |
| 能不动 P24 冻结契约实现吗？ | **不能**。需要新的 identity 维度（`groupOrder` 之外）⇒ **STOP，不实现** |
| 现在可以进入实现吗？ | **NOT READY**（Phase 5） |

---

## Phase 0 — Existing Reality Audit（只读）

### 0.1 planner v3 输入 / 输出结构

唯一 initial admission authority = `planParticipation`（`assets/js/group-runtime-core.js:582`），
`PARTICIPATION_PLANNER_ID = 'group-rule-v1'`、`PARTICIPATION_PLAN_VERSION = 3`
（`group-runtime-core.js:455`、`:461`）。

输入（`validateParticipationInput`，`group-runtime-core.js:485`）：

```js
{
  groupTurnId: 'gturn_…',
  trigger: { userMessageId: 'msg_…_u', text?: '<受限正文，不参与判定>' },
  participants: [ { id, status: 'active'|'muted'|'removed', mentioned: boolean } ],
  recentSpeakerIds?: [ '<canonical id>', … ],   // 可选；缺省 = []
  maxResponders?: 非负有限整数                  // 可选；null/undefined = unlimited
}
```

输出（`group-runtime-core.js:654`）：

```js
{
  groupTurnId, plannerId: 'group-rule-v1', planVersion: 3,
  entries: [ { speakerId, decision: 'speak', order: 0..k-1, reason: 'active-default'|'mentioned' } ],
  omitted: [ { speakerId, reason: 'removed'|'muted-not-mentioned'|'budget-limit' } ]
}
```

- `decision` 词表在 planner 输出里只有 `'speak'`：SKIP 者进 `omitted`，绝不产生 `'skip'` entry；
- reason 闭集（`group-runtime-core.js:464`）：SPEAK = `active-default` / `mentioned`；
  SKIP = `muted-not-mentioned` / `removed` / `budget-limit`；RESERVED（当前不产生）= `no-config`；
- `order` 只在 **selected** 上分配 `0..k-1`（`group-runtime-core.js:644-647`）；
  omitted 按 participant 输入顺序输出（`:648-653`）。

实测证据（node，本次审计运行）：

```text
cap=2、eligible=3 ⇒ entries=[a#0,b#1]、omitted=[{c,'budget-limit'}]
无 cap、active+muted+removed ⇒ omitted=[{b,'muted-not-mentioned'},{c,'removed'}]
```

### 0.2 `plannedEntries` 生命周期（`assets/js/communication.js`）

| 阶段 | 证据 |
|---|---|
| 创建 | `let plannedEntries=[]`（`:2216`） |
| 填充 | `plannedEntries=(_gPlan&&_gPlan.entries)||[]`（`:2292`），随后逐个映射 cfg（`:2294-2298`） |
| 失败清空 | entry→cfg 映射失败（`:2299-2303`）或 planner 异常（`:2305-2309`）⇒ `plannedEntries=[]` |
| 计账 | `_gTurn.plannedCount=plannedEntries.length`（`:2311`） |
| 消费 A | runtime state 输入（`:2401`，`entries:plannedEntries.map(...)`） |
| 消费 B | static 游标（`:2427-2429`，`_gRtCursor`） |
| 消费 C | deferred summary 选择执笔者（`:2773`，`pickGroupUtilityCfg(group,plannedCfgs)`） |

**结论**：`plannedEntries` 只在两处被整体**重新赋值**，**没有任何 in-place mutation**
（无 `push` / `splice` / 元素改写）。运行期没有任何路径"偷偷修改 planner output"。

### 0.3 `pendingEntries` mutation（`assets/js/group-runtime-core.js`）

| 动作 | 位置 | 语义 |
|---|---|---|
| 建 state | `createDynamicRuntimeState` `:1066`（`entries.slice()`） | 初始队列 = planner 顺序原样 |
| 出队 | `nextDynamicRuntimeEntry` `:1107`（`shift()`） | **先过 hard gate，再消费** |
| 入队（唯一） | `deferDynamicRuntimeEntry` `:1201`（`push()`） | DEFER 把已取出的 entry 追加到队尾 |

不存在 `insert` / `priorityInsert` / `resumeEntry` / `admissionPool`；
`markDynamicRuntimeSilent`（`:1168`）与 `markDynamicRuntimeStarted`（`:1110`）**不碰 `pendingEntries`**。

### 0.4 SPEAK / SILENT / DEFER 决策

`resolveDynamicRuntimeDecision`（`:1135-1165`）：

| 输入 | 结果 |
|---|---|
| 无 `ctx.decider` | `{speak, default}`（生产默认） |
| decider 抛错 / 非对象 | `{speak, fallback, 'decider-threw'|'malformed-result'}` |
| `'speak'` / `'silent'` | 采纳 |
| `'defer'` 首次 | 采纳；第二次 ⇒ `{speak, fallback, 'defer-limit'}` |
| `'interject'` 或未知词 | `{speak, fallback, 'unsupported-decision'|'unknown-decision'}`（`:1163-1164`） |

实测：`decider:()=>({decision:'interject'})` ⇒ `{"decision":"speak","source":"fallback","diagnostic":"unsupported-decision"}`。

决策词表闭集 `DYNAMIC_RUNTIME_DECISIONS = {speak, silent, defer}`（`:1003`）——**没有** `INTERJECT`。

### 0.5 hard gates

`canStartDynamicRuntimeEntry`（`:1079-1098`），优先级自上而下：

1. `cancelled`（最高）；
2. `unknown-entry`：entry 必须与 `initialEntries` **speakerId + order 同时精确匹配**（`:1084-1088`）；
3. `already-started`（one MemberTurn per speaker per GroupTurn）；
4. `already-silent`（silent 是终态）；
5. `removed`（statusById，turn-start 快照）；
6. `cap-reached`（`startedSpeakerIds.length >= responderCap`）；
7. `muted` **不是** runtime deny（planner 已合法准入 muted+mentioned）。

实测：`canStart(state, {speakerId:'friend_c', order:9})` ⇒ `{"ok":false,"reason":"unknown-entry"}`。

**这是本审计最重要的结构性发现**：现有 hard gate 把"合法 admission"定义为
"必须出现在 planner `initialEntries` 里"。任何 runtime 新增候选都**必然**被判 `unknown-entry` ——
这不是配置问题，而是"准入集合是闭集"的契约事实。

### 0.6 cancel authority

| 项 | 证据 |
|---|---|
| 唯一真值 | `_gTurn.cancelled`（`communication.js:4686`） |
| 唯一写入点 | `_ibGroupTurnCancel`（`:4704`，全文件仅此一处 `cancelled=`） |
| 唯一调用方 | `stopStreaming()`（`:3956`，`user_stop`） |
| runtime 侧 | gate/next 只**读** `ctx.cancelled`；`markDynamicRuntimeCancelled`（core `:1205`）**仅 telemetry** |
| 生命周期收口 | `_gTurn.status = cancelled \| completed`（`:2763`），`finally` 注销（`:2766`） |

不存在第二 cancel authority。

### 0.7 cap enforcement

两层，且都与 planner 权威不冲突：

| 层 | 位置 | 行为 |
|---|---|---|
| planner（选择） | `group-runtime-core.js:628-642` | 仅当 `eligible > cap` 时启用 tier 选择（mentioned > fresh > recent），溢出 ⇒ `omitted('budget-limit')` |
| runtime（执行闸门） | `:1094-1096` | `startedSpeakerIds.length >= responderCap` ⇒ `cap-reached` |

- `responderCap` 来自 **resolved policy** 的 `maxResponders`（`communication.js:2262`）；
  无字段 ⇒ `undefined` = unlimited（`_gResolvedCap`）；
- cap 是 **maximum，不是 fill target**：SILENT / DEFER 都不补位（`DYNAMIC-PARTICIPATION.md` §M3.5.2B F、§M3.5.2C D；
  测试 `test_group_dynamic_runtime.js` `S39`、`I54`）；
- 产品语义（UI 文案）：`InternalBeyond.html:2540-2542` ——「限制每轮最多由多少个角色回复 … 0 表示本轮不允许任何角色回复」。

### 0.8 `memberTurnId` 生成

```js
// group-runtime-core.js:109
turnId = 'turn_' + stableToken(groupTurnId + ':' + speakerId + ':' + groupOrder)
```

- 复用 `chat-core.stableToken`，与 P23 `delivery-sequence-core.turnIdFor(seed)` **跨模块等值**（同一哈希原语，
  漂移守卫见 `tests/test_group_turn_identity.js:129-131`）；
- `createMemberIdentity` 输出对象键集合**封闭**：`['turnId','groupTurnId','speakerId','groupOrder']`
  （`:151-162`；测试 `H.memberKeysClosed` at `test_group_turn_identity.js:270`，本次实测一致）；
- `validateMemberIdentity`（`:216-243`）会重算派生值，`turn-id-mismatch` 直接判非法；
- adapter：`_ibGroupMemberIdentity`（`communication.js:4623`）→ 建→校验→通过才返回，否则 `null`（fail closed）；
- 生产用法：`_ibGroupMemberIdentity(_gIdentity, cfg.id, entry.order)`（`:2464`），
  写入 canonical 只经 `extraMetadata`（`:2702`），工具续轮继承同一身份（`:4467`）。

### 0.9 communication.js · Group execution seam / writer / P23 / bypass

**Group execution seam（单点）**：

```text
userMsg.id → groupTurnId 派生（:2163）→ GroupTurn state（:2168）
  → 结构化 targeting 写 user metadata（:2181-2190，唯一一次 user canonical write）
  → ONE canonical snapshot（:2208）→ policy resolver（:2259）→ recent 派生（:2275）
  → planParticipation（:2291，全文件恰好 1 次调用）
  → 可选 runtime state（:2392-2413）→ 成员循环 for(;;)（:2418-2761）
```

**canonical message writer（群成员回合）**：

| writer | 位置 | 说明 |
|---|---|---|
| 主回复 | `communication.js:2710` `dbPut('chatMessages', aiMsg)` | 内容由 `_ibSequenceMessages`（`:2697`）→ `delivery-sequence-core.buildMessages` 构造，P24 三键只从 `extraMetadata` 进入 |
| 工具续轮 | `communication.js:4471` `dbPut('chatMessages', _cMsg)` | 同一 MemberTurn 的后续 sequenceIndex（`:4457-4467` 继承 `turnId` + P24 三键） |

群聊**没有**第三个"新建 assistant 行"的 writer：

- 拍一拍撤回（`_maybePatWithdraw`，`:5166`）**只**在单聊分支被调用（`:3382`），群聊不产生 `pat:true` 行；
- 模型自主撤回（`_applyWithdraw` → `_chatWithdrawSelf` → `_chatWithdrawMsg`，`:5208`/`:5199`/`:5145`）
  **群聊也会触发**（`:2664`），但它是**改写既有行**（`dbPut` 于 `:5156`），
  保留原 metadata（含 P24 三键），不新建成员回合、不改 planner / runtime。`_chatWithdrawSelf` 依赖
  `dbGetByIndex` + `_ibOrderMessages` 读 canonical 历史（只读）。

**P23 交付接口**：

- 群聊使用 **P23 2A 结构契约**（`delivery-sequence-core`，经 `_ibSequenceMessages`），
  但**不使用** P23 delivery runtime：`_ibStartDelivery` / `_ibDeliverUnit` 只出现在单聊分支（`:3297`、`:3343`、`:4852`、`:4881`）。
  ⇒ 群消息在生成时刻直接落库，没有投递队列/typing/cancel 队列语义。
- 因此 Phase 4 图里的 "P23 Delivery" 节点在群聊语境下 = **P23 sequence 契约 + Chat 域 canonical writer**；
  INTERJECT 不得新增第三条交付路径。

**runtime bypass 审计结果**：未发现群聊 canonical 写入绕过成员循环的路径。
残留的两处**身份**接缝（不是路径绕过）：

1. `_gMember === null` ⇒ 落到无群身份的 legacy 构造（`:2704`）——该行之后会被 `classifyMessageForSpeaker`
   判为 `UNKNOWN`（永不是 SELF），即"身份退化 = 角色自己的话不再是自己的"；
2. `memberCfgs` 用 `filter(Boolean)`（`:2141`）——**没有 `apiConfigs` 的群成员根本不进入 participants**，
   既不会被 planner 看到，也不在 `omitted` 里。

其它域（Active Message：无 `group_` 引用；IB.runtime：`communication.js` 零引用）不写群 canonical 消息。

### 0.10 identity：canonical memberId / groupOrder / memberTurnId

| 项 | 冻结值 | 证据 |
|---|---|---|
| canonical memberId | `apiConfigs.id`（= `metadata.speakerId` = `metadata.config_id` 同源；= `groups.members[].characterId` 经 `getGroupMemberIds`） | `P24-M2-SPEAKER-IDENTITY.md` §1；`P24-M3.5-TARGETING-CONTRACT.md` §1 |
| display name | 仅显示 / legacy 唯一精确匹配 | 同上 §7 |
| `groupOrder` | **planned participant order**：0 起，按 participants 数组顺序对 SPEAK 者递增；OMITTED 不占；空洞合法；绝不重编号；不是 successful-speaker order | `P24-M3-PARTICIPATION-CONTRACT.md` §7；`M3.5-DYNAMIC-PARTICIPATION.md` §4 |
| `memberTurnId` | `memberTurnIdFor(groupTurnId, speakerId, groupOrder)`；公式**不得修改** | `M3.5-DYNAMIC-PARTICIPATION.md` §H；测试 `test_group_turn_identity.js:133-137` |
| assistant metadata 键集 | 仅 `groupTurnId` / `speakerId` / `groupOrder`（+ P23 turnId/sequence） | `P24-M3.5-TARGETING-CONTRACT.md` §7 |

### 0.11 当前 INTERJECT 缺口列表

| # | 缺口 | 类别 |
|---|---|---|
| G1 | planner 输出没有"可插话池"这一语义（`omitted` 只是"未获准入"，不是"待补准入"） | 产品问题 + 契约 |
| G2 | `omitted` 甚至**没有进入 runtime**（adapter 只传 `entries`，`communication.js:2401`） | runtime queue 问题 |
| G3 | 无 `interjectEntry` / `resumeEntry` / `admissionPool` API；`pendingEntries` 只有 shift + defer-push | runtime queue 问题 |
| G4 | hard gate 把 admission 集合定义为 `initialEntries`（`unknown-entry`） | runtime queue 问题（实为契约闭集） |
| G5 | runtime 无 `interject` 决策词；注入 `'interject'` ⇒ fallback SPEAK | runtime queue 问题 |
| G6 | INTERJECT speaker 无 planner `order` ⇒ 无法派生 `memberTurnId` | **identity contract 问题** |
| G7 | `groupOrder` 语义冻结为 planned order，"插话者用哪个 order"未定 | **identity contract 问题** |
| G8 | member identity 对象键集合封闭（测试锁死 4 键）⇒ 无法悄悄加 `runtimeOrdinal` | **identity contract 问题** |
| G9 | assistant metadata 键集合冻结 ⇒ 新增 admission 维度需要版本决策 | **identity contract 问题** |
| G10 | cap 是否包含 INTERJECT 未定 | 产品问题 |
| G11 | targeting 是否授予插话权未定 | 产品问题 |
| G12 | INTERJECT 是否进入 `roundExtras` / 下一回合 `recent` / prompt 未确认 | 产品问题 |
| G13 | muted 未点名者能否插话未定（当前 planner 语义 = 不得绕过的 deny） | 产品问题 |
| G14 | 每 GroupTurn 插话预算（次数 / 每人上限）未定 | 产品问题 |
| G15 | 无任何生产消费者 / UI / 事件提出"本该有人插话"的信号 | 产品问题（需求门禁） |
| G16 | 无测试与 harness（现有 C 组只断言"未实现 + 边界未动"） | 测试缺口 |
| G17 | 撤回路径的身份判据仍是 **display name**：`_chatWithdrawSelf` 用 `x.senderName === senderName` 找"自己上一条"（`communication.js:5203`），同名角色可能撤回对方的消息 —— M2 的身份规则未覆盖该读写点 | identity contract 问题（既有残留，非 INTERJECT 引入） |

### 0.12 缺口分类

**产品问题（必须先有产品决策，代码无解）**

- G1 语义：`omitted` 是否应被解释为"待补准入"（这本身就是 planner 语义变更）；
- G10 cap 是否计入 INTERJECT；
- G11 targeting 是否 = 插话资格；
- G12 可见性（同轮后续成员 / 下一轮 recent / prompt）；
- G13 muted 未点名者的插话权；
- G14 插话预算；
- G15 **需求是否存在**。

**identity contract 问题（触碰 P24 冻结面）**

- G6 / G7 / G8 / G9：`groupOrder` 语义、`memberTurnId` 公式、member identity 键集、assistant metadata 键集
  —— 四者互相咬合，任一动都需要显式的 P24 版本决策。
- G17：撤回路径的 display-name 判等（`:5203`）是 M2 冻结的身份规则的**既有读路径残留**；
  与 INTERJECT 无因果关系，但属于同一身份域，应在独立阶段处理（不得借 INTERJECT 顺手改）。

**runtime queue 问题**

- G2 / G3 / G4 / G5：runtime 需要显式的准入集合扩展 + 队列 mutation API + 决策词，
  且当前 hard gate 会主动拒绝任何新 entry（`unknown-entry`）。

### 0.13 对 M3.5.2D 的一处事实修正

`M3.5.2D` §5.1 的前提「所有 eligible 参与者都会被选中 ⇒ 'eligible 但未被准入' 的集合为空」
**只在 cap 未生效时成立**。实测（`maxResponders:2`、3 名 active）：

```text
omitted = [{ speakerId:'friend_c', reason:'budget-limit' }]
```

即：**cap 生效时，`omitted` 里确实存在"eligible 但未获准入"的人**。
这不改变 §5 的结论（这些人是被 cap 裁掉的，runtime 放行即突破 cap 或等于重做选择），
但它把候选来源 A 的问题从"没有人群"精确化为"有人群，但放行会改写 planner 的 budget 竞争结果"。

---

## Phase 1 — INTERJECT Semantic Classification

### 结论：**A · Dynamic Participation Runtime Decision**

INTERJECT = 「一个**原本没有进入 initial `plannedEntries`** 的 canonical 群成员，
在当前 GroupTurn 生命周期内获得**一次** runtime admission（= 一次 MemberTurn）」。
它的效果是"谁在这一轮获得 MemberTurn"，因此与 SPEAK / SILENT / DEFER 同一决策族。

### 证据：为什么是 A

| 维度 | INTERJECT 的归属 | 证据 |
|---|---|---|
| 触发 | 用户群消息（GroupTurn） | `communication.js:2153-2168`（唯一触发点） |
| context owner | P24 + Chat 上下文 | `communication.js:2196-2362`（ONE snapshot / policy / recent / history） |
| 决策族 | "谁获得一次 MemberTurn" | `P24-M3-PARTICIPATION-CONTRACT.md` §1（Planner authority：只回答 WHO GETS A MEMBER TURN） |
| authority | planner v3 initial admission + runtime execution gates | `M3.5.2D` §D；core `:1079-1098` |
| executor | 既有成员循环 + Chat 执行器 | `communication.js:2453-2760`；`callApiChat`（`:5428`） |
| canonical writer | `chatMessages`（Chat 域），经 `metadata` 三键 | `communication.js:2710` |
| cancel | `_gTurn.cancelled` | `communication.js:4704` |
| persistence | ephemeral（无 DB / 无 metadata / 无 store） | `M3.5.2D` §K |

### 证据：为什么不是 B（Autonomy Action）

1. P25 autonomy action 是**闭集动作**：`moment.post` / `diary.write` / `active_message.send` / `activity.start`
   （`docs/P25-AUTONOMY-CORE.md` §3）——里面没有"参与/准入"这类动作；INTERJECT 不是动作，是准入结果。
2. Autonomy 需要 `actorId`（角色主动意图）+ 可选 scheduler/trigger；INTERJECT 的候选由**本轮群回合**产生，
   不是角色自己发起的自主行为。
3. `P25-AUTONOMY-CORE.md` §12 明确：P24 Dynamic Participation **不迁移**，
   未来即便接线也必须"保持 planner v3 / runtime hard gates 不变"。
4. `P28-1` §5 把 Group 的 authority / cancel / delivery 列分别归给"域权威 + P24 群回合取消 + P23"，
   §6 明确排除 "Autonomy Authority v2" 统一化；把 INTERJECT 交给 Autonomy = 让 Autonomy 拥有群参与准入。

### 证据：为什么不是 C（Group Capability）

Capability（`P25-3-CAPABILITY-INVENTORY.md` 那一层：发动态 / 写日记 / 主动消息 / 写信）是
**域已知动作**，由域自己执行；INTERJECT 不是一个动作，而是"某个成员是否获得 MemberTurn"的运行时判定。
它在 P28-1 §5 矩阵里落在 **Group 的 "决策/计划" + "authority" 列**，不是 capability 列。

### 证据：为什么不是 D（新的 Domain Runtime primitive）

`P28-1` §19/§21 的门禁要求：新运行时/新原语必须证明"不同的 owner / 信任边界 / 进程或运行时边界 / 失败语义"
至少有一条成立。INTERJECT 四项全部不成立：owner（P24）、信任边界（同一 canonical store）、
运行时边界（同一循环）、失败语义（fallback SPEAK，与 SILENT/DEFER 同族）都一致。
§11 的晋升规则同样要求这四条其一 ⇒ **不满足**。
§22 冻结 Shape D：保留 5 个域运行时 + `IB.runtime` 共享模型执行缝；INTERJECT 不构成新形状。

### 边界重申（用户给定的原则）

INTERJECT **不是** Active Message、**不是** P25 Autonomy Action、**不是** Agent Wake、
**不是** Capability execution —— 它是 **Group Runtime 内部的动态参与决策**，
但它需要扩展 A 类决策的**输入域**（admission 集合），这正是 Phase 3 要冻结的契约缺口。

---

## Phase 2 — Candidate Source Decision

四个问题：① 是否拥有 participation authority？② 是否绕过 planner v3？③ 是否改变用户事实？④ 是否需要新 authority？

**先给结论**：`REDUNDANT_CANDIDATE` —— 在当前 P24 冻结契约与当前生产需求下，
**不存在任何"既合法又不可被 planner 表达"的 INTERJECT 候选来源**。

### A. planner `omitted` entries

人群（实测）：`removed`（永不）/ `muted-not-mentioned`（不得绕过）/ `budget-limit`（cap 裁掉的合法 eligible）。

| 问题 | 回答 |
|---|---|
| 有 participation authority？ | **没有**。`omitted` 的定义就是"未获准入"；runtime 放行 = 第二层准入决策 |
| 绕过 planner v3？ | **会**（若 runtime 自行挑选）：planner 已就 budget 竞争给出结论（tier 选择 + 谁进 omitted） |
| 改变用户事实？ | **不会**（`omitted` 是派生结果，不是用户事实）；但 targeting 事实不得被改写成"准入池" |
| 需要新 authority？ | **需要**（runtime 自行挑选）；若改由 planner 显式输出"预授权候选"，则不需要新 authority |

**判定：需要新契约**（唯一可能的合法形态见下方"唯一合法化路径"）。

### B. all group members

| 问题 | 回答 |
|---|---|
| 有 participation authority？ | 没有（成员表 ≠ 准入池） |
| 绕过 planner？ | **会**：muted / removed / eligibility 要在 runtime 重判（P24 明确禁止） |
| 改变用户事实？ | 会间接改变：mention/targeting 的语义被 runtime 稀释 |
| 需要新 authority？ | 需要（第二套 participation authority） |

**判定：不合法**。附结构证据：无 `apiConfigs` 的成员根本不进 participants（`communication.js:2141`），
所以"全量成员"与"planner 可见参与者"本就不是同一集合。

### C. recent speakers

| 问题 | 回答 |
|---|---|
| 有 participation authority？ | 没有。`recentSpeakerIds` 是 **pre-turn 上下文输入**（派生自 canonical 历史，`group-runtime-core.js:399`） |
| 绕过 planner？ | **会**：recent 的消费语义（tier 竞争）在 planner 内部，runtime 复用 = 重判 |
| 改变用户事实？ | 不会 |
| 需要新 authority？ | 需要（把上下文信号升格为准入来源） |

**判定：不合法**（作为候选来源；作为 planner 内部优先级输入则早已合法存在）。

### D. targeting candidates

| 问题 | 回答 |
|---|---|
| 有 participation authority？ | 没有。`targetSpeakerIds` 是**用户事实**，语义是 priority / relevance（`P24-M3.5-TARGETING-CONTRACT.md` §6：target ≠ exclusive） |
| 绕过 planner？ | 现状**不会**：target → `mentioned` 布尔 → planner 决定（muted+mentioned 才转 eligible） |
| 改变用户事实？ | 把"事实"改读成"资格/强制权"= 改变语义（不改数据，但改含义） |
| 需要新 authority？ | 若产品要"被点名 ⇒ 自动获得插话权"，则需要新契约（产品语义变更） |

**判定：不合法（作为准入池）；若产品显式定义"targeting 授予插话权"⇒ 需要新契约**。

### E. memory recommendation

| 问题 | 回答 |
|---|---|
| 有 participation authority？ | 没有（`P24-M3-PARTICIPATION-CONTRACT.md` §13：MB/Memory 只能 advisory，不得替代 planner authority） |
| 绕过 planner？ | **会**（recommender → admission 的直通） |
| 改变用户事实？ | 会（把模型的推测变成"谁必须说话"） |
| 需要新 authority？ | 需要 |

**判定：不合法**。

### 唯一可能的合法化路径（仍不构成"今天可实现"）

若未来产品确认需求，唯一不引入第二 authority 的形态是：

```text
planner v4（显式）输出 pre-authorized 候选类别（例如 ordered alternates，仅来自 budget-limit 等被显式允许的 reason）
  → runtime 只在 hard gates 全部通过、且 cap 仍有空位时执行"预授权提升"
  → 提升仍受 one-MemberTurn-per-speaker / cancel / removed / cap 约束
```

即使这样：planner 契约版本、reason 词表、identity 维度、cap 语义、可见性都需要重新冻结 ——
**因此这仍然是"需要新契约"，不是今天可实现的 INTERJECT**。

---

## Phase 3 — Freeze Missing Contracts

### 1. `groupOrder`

当前冻结：planned order 不修改；空洞合法；不允许重新编号（`P24-M3-PARTICIPATION-CONTRACT.md` §7）。

| 候选 | 分析 | 是否破坏 identity contract |
|---|---|---|
| A. `runtimeOrdinal` | 新增**正交维度**；`groupOrder` 语义、值域、公式全部原样；interject entry **没有** `groupOrder` | **不破坏**已冻结的 `groupOrder` 语义；但需要新的 identity 形状（见 §2） |
| B. append after planned order | 需要**伪造**一个 planner 从未分配的 `order`（`max+1`）。这会让 `groupOrder` 不再等于"planned participant order"，并让同一字段同时表示两种来源 | **破坏**（`groupOrder` 语义被悄悄扩展成 "planned-or-runtime order"） |
| C. 扩展 `groupOrder` | 明确不推荐（`M3.5.2D` §G③）；且 `memberTurnIdFor` / `validateMemberIdentity` 的派生校验会让它立刻暴露 | **破坏** |

**判定：A（`runtimeOrdinal`）**。
注意 A 只是"不破坏已有 contract"，它**不等于"不需要新 contract"**：
interject entry 的 identity 需要一个显式的 runtime 维度与新的 metadata 表达（见下）。

### 2. `memberTurnId`

现状：`memberTurnIdFor(groupTurnId, speakerId, groupOrder)`；interject speaker **没有 planner order** ⇒ 无法派生。

| 候选 | 分析 |
|---|---|
| A. 用 `runtimeOrdinal` 直接喂现有公式 | 形式上不改公式，但**重载了第三个参数**的语义；`metadata.groupOrder` 会被写成 runtime 值（违反 §1），或必须新增字段（见 B）⇒ 名字相同、含义不同 = 隐藏漂移 |
| B. `memberTurnId` v2（新 seed 命名空间） | 例：`'turn_' + stableToken(groupTurnId + ':' + speakerId + ':rt:' + runtimeOrdinal)`；v1 公式与取值**逐字不变**，planned 路径仍满足与 P23 `turnIdFor` 的等值守卫；interject 路径与任何 planned order 不可能碰撞（命名空间不同）；需要一个显式新 metadata 维度 |
| C. 保持公式不动 + wrapper | wrapper 只能(a) 复用 `order` 槽（= A 的漂移），或(b) 放弃群身份（落到 `communication.js:2704` 的 legacy 构造）⇒ 该消息在后续回合被判 `UNKNOWN`（永不是 SELF），破坏 persona 连续性/recent 派生。**不可接受** |

**判定：B（新的 identity 形状）**，且必须以"新增可选形状 + v1 逐字不动"的方式做。
由于 `member identity` 键集被测试锁死（`H.memberKeysClosed`）且 `M3.5.2D` §H 明确"不得修改 `memberTurnIdFor` 公式"，
这属于 **P24 identity contract 版本变更**。

### 3. `cap`

产品语义（UI）：`maxResponders` = 每轮最多由多少个角色回复（`InternalBeyond.html:2540-2542`）。

三种可能的自然后果，逐一判断：

| 方案 | 后果 | 判定 |
|---|---|---|
| 默认"INTERJECT 计入 cap" | 由于 planner 在 `eligible > cap` 时会把 entries 填满到 cap，插话在任何 cap 绑定场景下都没有名额；而 cap 不绑定时 planner 已准入所有 eligible ⇒ 插话人群为空 | **保持 cap**（当前默认），并暴露"功能是空的"这一事实 |
| "点名/插话可突破 cap" | 需要新的 policy 字段 + 新契约版本（`M3.5.2D` §I 明确这是**显式**产品语义变更） | 需要：新 policy 字段 + 新 version |
| runtime 侧偷偷放宽 | 违反 P24 冻结（cap 是 planner/runtime 共同守卫的硬边界） | **禁止** |

**判定：默认保持 cap；如需放宽 ⇒ 新 policy 字段 + 新 version（产品决策，不是 runtime 决策）**。

### 4. targeting

必须把三件事拆开：

| 角色 | 是否成立 | 证据 |
|---|---|---|
| **提供事实**（"用户当时 @ 了谁"） | ✅ 成立 | `metadata.targetSpeakerIds` 是持久化事实；structured 路径原样返回（含已退出成员）`P24-M3.5-TARGETING-CONTRACT.md` §4/§B |
| **提供资格**（是否获得准入） | ⚠️ 部分且**仅在 planner 内**：target → `mentioned` 布尔 → planner 规则（muted+mentioned 才转 eligible） | `group-runtime-core.js:605-613`；target 不突破 cap、不改 recent window（§6） |
| **提供强制插话权** | ❌ 不成立 | 被点名者仍可 SILENT / DEFER（`M3.5.2D` §F）；target 不是 `forced speech` |

**判定**：targeting 只是事实 + （planner 内的）优先级；**不得**被解释为"强制插话权"，
也不得被 runtime 用作准入池。若产品要"被点名 ⇒ 插话权" ⇒ 需要新契约。

---

## Phase 4 — Runtime Boundary Check

### 正确归属（与用户给定方向一致）

```text
Group Runtime（P24）
  planner v3（唯一 initial admission authority，每 GroupTurn 一次）
        │
        ▼
  Dynamic Participation Runtime（decision + hard gates + queue；ephemeral）
        │
        ▼
  Group Executor（成员循环：identity → typing → Chat 执行器）
        │
        ▼
  P23 sequence 契约（delivery-sequence-core）+ Chat 域 canonical writer（chatMessages）
```

证据：

- runtime 决策与 hard gates 全在 `group-runtime-core.js`（纯模块，零 DOM/DB/时钟/随机）；
- 执行体与 writer 全在 `communication.js` 群分支（`:2418-2760`），身份只经 adapter；
- 模型执行走既有 `callApiChat`（`:5428`），与 P28-1 §5 矩阵中 Group 的"模型路径 = Chat 执行器"一致；
- cancel 唯一（§0.6），delivery 唯一（P23 契约），writer 唯一（Chat 域）。

### 禁止的接法（本审计确认未被引入，且未来也不得引入）

| 禁止 | 现状 | 依据 |
|---|---|---|
| Group Runtime → Autonomy Core | 无引用（`autonomy-core.js` 与 P24 零耦合） | `P25-AUTONOMY-CORE.md` §12；P28-1 §6/§22 |
| Group Runtime → Agent Runtime | `communication.js` 零 `IB.runtime` 引用；`agent-runtime.js` 不含 group 身份/delivery/queue | P28-1 §4/§6/§14 |
| 新 Authority / 新 Canonical Writer / Event Bus / 新 store | 不存在（`DB_VER=24`，无 runtime store） | P28-1 §23/§24 |
| 第二条交付路径 | 不存在（群聊不经 `_ibStartDelivery`） | §0.9 |

**结论**：INTERJECT 必须留在 Group Runtime 内部；它不需要、也不得使用 Autonomy / Agent Runtime / Event Bus。

---

## Phase 5 — INTERJECT Implementation Readiness

```
Status:

NOT READY

Required decisions:

1. 需求门禁（最高优先）：是否存在真实、可命名的产品需求与消费者（谁产生"本该有人插话"的意图、
   谁被承诺了什么用户可见结果）。当前生产无任何此类信号 ⇒ 若无 ⇒ 明确标记 REDUNDANT_CANDIDATE 并关闭本方向。
2. 候选来源：是否接受"planner v4 显式输出预授权候补（ordered alternates）"这一唯一合法形态；
   若接受，明确哪些 reason 可成为候补（removed 必须永久 hard deny，muted-not-mentioned 需产品明示）。
3. cap 语义：INTERJECT 是否计入 maxResponders（默认计入 ⇒ 功能为空；若可突破 ⇒ 新 policy 字段 + 新契约版本）。
4. 可见性：插话回复是否进入 roundExtras / 下一回合 recent / provider prompt（这些今天都是自动行为，必须显式确认）。
5. targeting 与 muted：被 @ 是否授予插话资格；muted-未点名者能否插话。
6. 每 GroupTurn 的插话预算（次数上限、每人上限、与一次 DEFER 的关系）。
7. identity：接受 runtime ordinal 作为新维度、接受 memberTurnId v2（新 seed 命名空间）与新增 metadata 维度。

Required contract changes:

P24 version bump（identity 维度 / memberTurnId v2 / assistant metadata 键集）
new identity contract（新的可选 MemberTurn 形状；v1 公式与取值逐字不动）
（若采用 planner v4 候补）planner contract v4（输入/输出 + reason 词表）
（若突破 cap）participation policy 新字段 + 新 version

Production files allowed to touch（仅在上述决策全部冻结之后）:

assets/js/group-runtime-core.js      （pure：runtimeOrdinal 维度、预授权候补的 gate/queue、decision 词表）
assets/js/communication.js           （仅群分支成员循环 seam：决策点、准入、identity/metadata 构造）
assets/js/social.js                  （仅当新 policy 字段被批准：storage/UI adapter）
InternalBeyond.html                  （仅当新 policy 字段被批准：策略 UI 选项）
docs/P24-M3.5-DYNAMIC-PARTICIPATION.md / docs/P24-*.md / docs/P28-*.md（契约文档）
tests/test_group_*.js + tests/test-all.js（注册）

Production files forbidden:

assets/js/delivery-planner.js、multimodal-delivery-policy.js、delivery-sequence-core.js、
delivery-runtime.js、voice-message-core.js        （P23 五核心，零引用）
assets/js/middle-brain.js、assets/js/memory.js    （recommender ≠ authority）
assets/js/autonomy-core.js、assets/js/agent-runtime.js、P25 编排/适配层（禁止 Autonomy / Agent Runtime 接入）
planner 本体（planParticipation / reason 词表 / planVersion）——除非 v4 被显式批准为独立阶段
targeting / recent 派生链路（不得作为准入池被改写或重解析）
assets/js/social.js 的成员语义、groups schema、DB migration、DB_VER
单聊分支（NORMAL 1-ON-1 CHAT 与 P23 delivery runtime）
任何新 store / Event Bus / 新 Authority / 新 Canonical Writer

Tests required（实现阶段的最低集合）:

1. planner 未变守卫：planVersion / plannerId / reason 词表 / planParticipation 调用点 = 1（除非 v4 已批准）。
2. hard gates：interject 候选必须逐个被 cancelled / removed / cap / one-turn-per-speaker / unknown-entry 拒绝的用例；
   以及 cap 空位场景下的允许用例（若该语义被批准）。
3. identity：v1 公式与取值逐字不变（与 P23 turnIdFor 等值守卫保持绿）；
   runtime 维度生成的 turnId 与任何 planned order 不可能碰撞；validateMemberIdentity v2 的接受/拒绝矩阵；
   metadata 键集合断言。
4. queue：与 DEFER 的相对顺序确定、无死循环、插话预算收敛、planned order 绝不重编号、空洞保留。
5. 边界守卫：无第二 cancel authority / 无第二 writer / P23 五核心零引用 / MB·Memory·Autonomy 零引用 /
   DB_VER=24 / runtime state 无 DB·localStorage·canonical metadata。
6. 差分基线：gate 关闭 ⇒ 计划与执行逐字等价；gate 打开但无插话 ⇒ 与 M3.5.2C 逐字等价。
7. E2E：SILENT + DEFER + INTERJECT 交叉、cap 绑定、turn 中 cancel、targeting 事实不被改写。
```

### STOP 声明

- 实现 INTERJECT 需要 **P24 冻结契约的显式扩展**（identity 维度 / `memberTurnId` v2 / assistant metadata 键集），
  以及 planner 或 policy 的版本变更。
- 按本阶段限制：**停止，不实现**。本审计不产生任何 production 变更、不产生 DB migration、不接入 Autonomy/MB。
- 在当前 P24 冻结契约与当前生产需求下：**`REDUNDANT_CANDIDATE`**。
