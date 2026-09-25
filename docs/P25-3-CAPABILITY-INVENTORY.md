# P25-3 · IB Capability Inventory

状态：**审计结果（只登记真实存在、且能证明边界的能力）**。P25-3A 只把 **Moments**
登记成 reference adapter；其余能力本阶段只登记、**不接线**。

审计口径（每个能力回答 §4 的 A–M）：入口 / 触发者 / 是否调用模型 / 独立 authority /
独立 policy / executor / canonical writer / scheduler / 双 runtime / 依赖 Memory /
依赖 Middle Brain / 是否适合成为 capability / kind。

---

## 1. Capability 表

| Capability | Domain | Current Entry | Authority | Executor | Writer | Side Effects | Runtime | Migration Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `moment.post` | Moments | `_momentsRunAutonomousPost`（浏览器）/ companion `executeMomentSchedule`（Node 发事件） | **P25-2 Autonomy**（`runMomentAutonomy`） | `_momentsWriteApprovedMoment` / `_momentsWriteCompanionMoment` | `createMoment → _momentsWriteCanonical` | local（Moment 行 + 可选图片 + AI 互动） | browser + Node companion（事件） | **已接线（P25-2/2D）**；P25-3A 只登记 descriptor |
| `moment.like` | Moments | `likeMoment(id, likerId)` | **P25-2.5 Mutation**（`like` / `unlike`） | 同函数内 executor | `dbPut(MOMENT_STORE)` | local | browser | **已接线（P25-2.5）** |
| `moment.comment` | Moments | `addMomentComment(id, data)` | **P25-2.5 Mutation**（`comment.create`） | 同函数内 executor | `dbPut(MOMENT_STORE)` | local（评论 + @ 触发 + 回复链推进） | browser | **已接线** |
| `moment.reply` | Moments | `addMomentComment(id, {replyTo})` | **P25-2.5 Mutation**（`reply.create`） | 同上 | `dbPut(MOMENT_STORE)` | local | browser（+companion 事件） | **已接线** |
| `moment.comment.delete` | Moments | `deleteMomentComment(mid, cid, roleId)` | **P25-2.5 Mutation**（`comment.delete`） | 同上 | `dbPut(MOMENT_STORE)` | local | browser（+companion 事件） | **已接线** |
| `moment.delete` | Moments | `deleteMoment(id, opts)` | **P25-2.5 Mutation**（`moment.delete`） | 同上 | `dbDelete(MOMENT_STORE)` | local | browser | **已接线** |
| `diary.write` | Diary | `generateDiaryEntry(characterId, opts)`（`assets/js/active-diary/diary.js`） | **Diary Authority**（`assets/js/diary-authority.js` · `runDiaryWrite`；模型输出只提供内容，不授予写权限） | `_diaryWriteCanonical(entry)`（同文件内 executor 闭包） | `_diaryWriteCanonical → dbPut(DIARY_STORE)`；`_diaryWriteMemory → memories` 为**写入成功之后**的 secondary side effect | local | browser（周记/每日 planner tick） | **已接线（P25-3B）**；orchestration adapter 只登记（未加载进页面） |
| `active_message.send` | Active Message | `_activeTick`/`_activeClaimDue`（设定计划）、`_activeTickAiPlans`/`_activeExecuteAiPlan`（AI 计划）、`_activeRunNow`（手动）；Node `services/active-message-service.js` + `active/scheduler.js` | **Active Message Authority**（`assets/js/active-message-authority.js` · `runActiveMessageSend`；模型输出只产正文，不授予发送权限）—— **浏览器与 Node companion 共用同一个权威** | 浏览器：`_activeSendAuthorized`（设定/手动）+ `NS.active.sendAuthorized`（AI 计划）；Node：`active/scheduler.js` 的 `_authorizeSend` / `_sendRequest` | 浏览器：`_activeWriteCanonical → dbPut('chatMessages')`（唯一 canonical 写点）+ `ACTIVE_HISTORY_STORE`；Node：`events` / `history`（浏览器再镜像落库，不双写） | local（消息进会话流 + 可选本机通知；无 push / 无 TTS） | browser + Node companion（两端同一权威） | **已接线（P25-3C 浏览器域 + P25-3C-Node companion）**；见 docs/P25-3C-ACTIVE-MESSAGE-CAPABILITY.md、docs/P25-3C-NODE-ACTIVE-MESSAGE.md |
| `role_letter.write` | Role Letters | `assets/js/role-letters.js`（角色互写信：`_roleLettersTick` → `_rlInitStep` cadence / `_rlReplyStep` 回信） | **Role Letter Authority**（`assets/js/role-letter-authority.js` · `runRoleLetterWrite`；模型只产信件正文，不授予写信权限） | `_rlStoreLetter` 内的 executor 闭包（同文件） | `_rlWriteCanonical → dbPut('roleLetters')`（**唯一**写点；replyStatus/readAt 状态更新走同一 writer）+ `roleLetterMemories`（私有命名空间，非 Memory 子系统） | local（页内 toast；无 OS 通知 / 无 push） | browser | **已接线（P25-3D）**；orchestration adapter 只登记（未加载进页面） |
| `voice.speak` | Voice | `assets/js/communication/voice.js`（TTS 播放/合成） | 无（用户动作或交付时） | 同文件 | 无 canonical 写（音频） | 无（音频输出） | browser + Node bridge | **不适合作为 orchestration capability**（不是领域动作，是交付通道） |
| `activity.start` | Activity | `assets/js/activity/activity-runtime.js`（`dbPut(ACT_STORE)` + `chatThreads`） | 无独立 authority | 同文件 | `dbPut(ACT_STORE)` | local | browser | **未迁移** |
| `coread.observe` | Co-read | `assets/js/activity/coread.js` | 无独立 authority | 同文件 | 复用 activity 存储 | local | browser | **未迁移** |
| `cinema.observe` | Cinema | `apps/ib-app-cinema.js`（播放器 + 角色反应） | 无 | app 内 | 无 canonical 写 | none | browser | **未迁移**（且当前没有可证明的写边界） |
| `memory.write` | Memory | `saveMemory` / `quickCreateMemory`（`assets/js/memory.js`） | **Memory Authority**（Home Node canonical；`memoryAuthority.put`） | memory.js | `memoryAuthority.put` / 镜像 `dbPut('memories')` | local | browser + Node | **本阶段禁止接入**（P25-3 明令） |
| `economy.propose_purchase` / `economy.approve` / `economy.settle` | Economy | Node `proposeAgentPurchaseIntent` / `preparePurchase` / `settlePurchase`（`services/home-node/economy-store.js`） | **Economy authority**（policy + 审批 + CAS + 幂等） | `economy-action-adapter` | economy-store（SQLite canonical） | local（无真实支付 ⇒ 无 external） | Node | **本阶段禁止接入** |

## 2. 分类（taxonomy）

最小充分分类（§6）：`read` / `write` / `action`。

| kind | 判据 | 例子 |
| --- | --- | --- |
| `read` | 不改变任何持久状态 | 未来 `moment.read`、`memory.read`（本阶段未登记真实实现） |
| `write` | 产生/修改领域数据（本地持久） | `moment.post` / `moment.like` / `moment.comment` / `diary.write` / `active_message.send` |
| `action` | 删除或不可逆状态迁移（仍属本地） | `moment.delete` / `moment.comment.delete` / 未来 `economy.settle` |

sideEffect：`none`（纯读）· `local`（本地持久 / 本地副作用）· `external`（真实外部世界）。
**当前 IB 没有任何 capability 声明 `external`** —— Economy 没有真实支付，本阶段不制造不存在的副作用。

authorityType 声明（实现永远在 domain 侧）：`autonomy`（P25-2 创建）· `mutation`（P25-2.5 修改）·
`domain`（各域自有权威，如 Economy / Memory）· `manual`（用户动作，无需编排裁决）· `read-only`（读）。

## 3. 适合 / 不适合成为 capability

**适合**（有明确入口、authority、executor、writer 边界）：Moments 全部 6 项、Diary、Active Message、
Role Letters、Activity、Co-read、Memory、Economy。

**不适合**（本阶段结论）：

- `voice.speak`：交付通道而非领域动作（其权威在交付层：P23 delivery / TTS 本地策略）；
- `cinema.observe`：纯前端播放，当前没有 canonical 写边界可声明；
- `image.*`：图片是 Moment / 消息的增强步骤（P25-2 已证明"ALLOW 后才生图"），
  独立登记会把一条内部步骤伪装成用户可见能力（本阶段不登记）。

## 4. P25-3A 登记范围

| 登记 | 位置 |
| --- | --- |
| `moment.post` … `moment.delete`（6 项） | `assets/js/agent-orchestration-moments-adapter.js` |
| 其余能力 | **只在本文件登记**（descriptor 未注册进 registry） |

理由：§30 明确"Moments 是本阶段唯一允许做的 reference adapter"，其余能力的 descriptor
需要各自的 authority/executor 证据才能登记 —— 那属于 P25-3B+。
