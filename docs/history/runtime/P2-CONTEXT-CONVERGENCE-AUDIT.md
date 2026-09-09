# P2 · Context Convergence Audit（只读核实）

审计范围：P2-03（Middle Brain 重复检索／重复注入）、P2-04（browser/companion context contract 差异）。
性质：**只读核实**。本次不改上下文构建、不统一字段、不迁移触发器；结论用于 Runtime Convergence Phase 1 的输入。
基准：工作区当前状态（含 P2-01/02/05/07 修复）。证据等级：B（执行真实函数/读取真实源码调用关系），未接真实 Astra 做 token 计量。

---

## 1. P2-03：Middle Brain 重复检索与重复注入（已核实，仍存在）

### 1.1 同一轮单聊里，记忆/理解/线索/动态各被读取两次

| 顺序 | 位置 | 行为 |
|---|---|---|
| ① | `assets/js/communication.js:1348` | `getMemoryContext(cfg.id,{userMessage:_ctxText})` → 召回 + **写激活计数** |
| ② | `assets/js/communication.js:1351/1353/1355` | `getUnderstandingContext` / `getThreadContext` / `getMomentsContext` |
| ③ | `assets/js/communication.js:1365` | `middleBrainCompressPipeline(cfg.id, _ctxText, {})` —— **opts 为空** |
| ④ | `assets/js/middle-brain.js:455-456` | `opts.memoryCtx == null` → 再次 `getMemoryContext(characterId,{userMessage})` |
| ⑤ | `assets/js/middle-brain.js:463-464 / 471-472 / 479-480` | 再次 `getUnderstandingContext` / `getThreadContext` / `getMomentsContext` |

`getMemoryContext` 不是纯读：`assets/js/memory.js:117-123` 对入选记忆 `activationCount+1`、`lastActivated=Date.now()` 并写库。
因此开启 Middle Brain 的一轮对话，同一批记忆会被**激活两次**，衰减评分与"近期活跃"排序被放大。

### 1.2 压缩结果是"追加"，不是"替换"

`assets/js/communication.js:1366-1367`：Astra 成功时把 `compressedContext` 追加到 `_tailCtx` 末尾，**原 Memory / Understanding / Thread / Moments 块全部保留**。
`middle-brain.js:489-499` 的去重只发生在 Middle Brain 自己的行集合内部，不与原始块做交叉去重。
后果：同一事实在一轮请求里出现两次；"压缩"不减少 token，反而增加。`source==='local'` 时才不追加。

### 1.3 接缝已具备修复条件（本次不修）

`middle-brain.js:454/462/470/478` 已支持 `opts.memoryCtx / understandingCtx / threadCtx / momentsCtx` 直传。
即：修复只需在**调用点**把已读块传入 pipeline（并明确"追加 vs 替换"的产品语义），**不需要改 middle-brain.js**。
本次不做，因为"替换"会改变现有上下文内容，属于 Convergence 阶段的行为决策。

### 1.4 未测量项（不得当作已证明）

未用真实 Astra 端点测量重复率、字符/token 增量与召回命中变化；以上为结构性结论（调用关系 + 真实函数副作用），非线上计量。

---

## 2. P2-04：browser / companion context contract 差异（已核实，仍存在）

### 2.1 字段矩阵（✅=该路径实际构建并进入 prompt；—=不构建；△=构建但不进 prompt）

| 字段 | 单聊 Chat（浏览器） | 群聊 Chat（浏览器） | Proactive（浏览器前台） | Proactive（companion） | Moments（浏览器前台） | Moments（companion） |
|---|---|---|---|---|---|---|
| 身份/关系（systemPrompt / relationship） | ✅ | ✅（每成员独立） | ✅ | ✅ | ✅ | ✅ |
| 站点上下文 / Blog 指令 | ✅ | — | — | — | — | — |
| 日历 system + tail | ✅ | — | — | — | — | — |
| 时间（tail） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 正在听（音乐） | ✅ | — | — | — | — | — |
| 对话摘要 chatSummary | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 最近消息 recentMessages | ✅（含话题历史） | ✅ | ✅（≤16） | ✅（≤16） | ✅ | ✅（≤14） |
| Memory（`getMemoryContext`） | ✅ | ✅（groupMemEnabled 门控） | — | — | — | — |
| Memory（`_activeRecentMemories` 另一套召回） | — | — | ✅（固定 8） | ✅（固定 8） | ✅ | ✅（≤8） |
| Auto Memory（sys+tail） | ✅ | 独立开关 | — | — | — | — |
| Understanding | ✅ | — | — | — | — | — |
| Thread（open thread） | ✅ | — | — | — | — | — |
| Moments 上下文 | ✅ | — | — | — | — | — |
| **roleLetterMemories** | — | — | ✅ | **—（缺失）** | ✅ | **—（缺失）** |
| Activity 上下文 | ✅ | — | — | — | — | — |
| 工具/工作区结果 | ✅ | — | — | — | — | — |
| 主动消息历史 | — | — | ✅（≤10） | ✅（≤10） | — | — |
| 自己的近期动态 | — | — | — | — | ✅（≤6） | ✅（≤6） |
| 其他角色动态 | — | — | — | — | ✅ | ✅（≤8） |
| 回复链线程 recent_threads | — | — | — | — | △（仅快照） | ✅（仅回复链） |
| prefs（aiComment/enabled） | — | — | — | — | ✅ | ✅ |

### 2.2 断点位置（精确到行）

- 前台构建：`assets/js/moments.js:433-447`（`_momentsContext`，含 `roleLetterMemories`）、`assets/js/active-diary.js:364-373`（`loadProactiveMessageContext`，含 `roleLetterMemories`）。
- 前台 prompt 使用：`assets/js/moments.js:492`、`assets/js/active-diary.js:392`（`【角色私信记忆】` 块）。
- 快照边界：`assets/js/moments.js:1457-1469`（`_momentsCompanionSnapshot`）、`assets/js/active-diary.js:1012`（`_activeBuildSnapshot`）——两者都**没有** `roleLetterMemories`。
- Node 侧：`active/moments.js:361-367`（快照归一化）与 `active/moments.js:165-214`（`buildMomentPrompt`）、`active/model-client.js:126-185`（`buildProactivePrompt`）——只消费快照里存在的字段，因此角色私信记忆在后台不可达。

### 2.3 门控语义差异（不是同一个开关）

- 普通 Memory：单聊无开关；群聊受 `groupMemEnabled`；话题（thread）受 `thread.memoryEnabled`。
- Auto Memory：独立开关（`amEnabled(cfg)`），与上面三者互不联动。
- 结论：不能把"话题关记忆"当成"该会话无记忆"，也不能用统一 Memory 开关替代 Auto Memory。

### 2.4 可收敛的字段（Runtime Convergence Phase 1 的候选清单）

按"收敛风险从低到高"排序，**本次均未实施**：

1. **时间 / 摘要 / 最近消息 / 主动消息历史**：语义已在前后台一致，只是长度与截断位置不同（16/14/10 等）。可收敛为一个 `ContextWindow` 契约（字段名 + 上限 + 排序规则）。
2. **Memory 块**：存在**两套召回实现**——
   - `getMemoryContext`（`assets/js/memory.js:61-126`）：衰减评分 + 预算裁剪 + **写激活计数**；单聊默认预算取 `memSettings.budget||2000`（`communication.js:1348` 未传 maxChars），群聊 `maxChars:1500`（`communication.js:1417`）。
   - `_activeRecentMemories`（`assets/js/active-diary.js:346-353`）：全表 + 关键词相关度排序 + 固定 8 条、无激活副作用、无预算参数；Proactive 前后台都用它。
   两者字段形状也不同（后者只有 title/content/summary/created/relevance）。收敛点：`memory: {items, budget, gatedBy, sideEffects}`，并顺带修掉 P2-03 的二次检索。
3. **roleLetterMemories**：字段本身两边同名，仅"是否进入快照"不同。收敛点唯一：把该字段加入两个快照 + 两个 Node prompt（或明确产品上不注入，二者取一）。
4. **Moments / 其他角色动态**：前台与快照字段名不同（`recentMoments` vs `recent_moments`、`otherRoleMoments` vs `other_role_moments`），可用统一 snake_case 契约 + 单一序列化器收敛。
5. **Understanding / Thread / Activity / 工具结果**：目前只在浏览器侧存在。收敛前必须先决定这些层是否属于"角色 Runtime 的公共上下文"；若属于，需要 companion 侧的可持久化投影，风险最高。
6. **门控位**：建议收敛为显式 capability 描述（`contextPolicy: {memory, autoMemory, understanding, thread, moments, letters, activity}`），避免继续用散落的布尔条件判断。

### 2.5 明确不建议在 Convergence Phase 1 做的事

- 不要把所有上下文无条件追加到所有触发器（会放大 token 与串味）。
- 不要用"统一 Memory 开关"覆盖 Auto Memory / 话题门控的既有语义。
- 不要在未决定 roleLetterMemories 产品语义前，同时改前后台两处 prompt。

---

## 3. 与 Runtime Convergence Phase 1 的关系

- `IB.runtime` 的 Context 契约（`agent-runtime.js` 的 `loadContext` / `composeMessages`）已经声明了 `user / character / recentMessages / memories / recentProactiveMessages / chatSummary / recentMoments / otherRoleMoments / roleLetterMemories / lastInteractionAt`。
  本次核实表明：**该契约的字段集合与前台 Moments/Proactive 的 `_momentsContext` / `loadProactiveMessageContext` 实际返回一致**，因此可作为收敛目标形状；但 companion 侧目前只覆盖其中一部分。
- 迁移顺序建议：先收敛字段形状与门控描述（纯数据层），再迁移第一个触发器；Middle Brain 的重复检索应在迁移单聊之前解决，否则会把"读两次"一起搬进 Runtime。

证据边界：以上结论来自源码调用关系与函数语义核对；未对真实 Astra/角色 provider 做 token 计量，未修改任何上下文构建代码。
