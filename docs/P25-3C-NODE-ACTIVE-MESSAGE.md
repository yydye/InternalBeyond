# P25-3C-Node · Active Message Companion Runtime Convergence

状态：**Active Message Capability FULL RUNTIME INTEGRATED**。Node companion 的发送出口
（`active/scheduler.js` 的 `executeTask` / `executePlan`）不再自行判断 send —— candidate 与
既有 facts 交给与 **Browser 共用的同一个** Active Message Authority（同一份
`assets/js/active-message-authority.js`），只有 ALLOW 才走既有出口（事件 / 历史 / 通知）。

实现位置：

- `active/scheduler.js`（发送授权接缝：`_activeMessageAuthority` / `_authorizeSend` / `_sendRequest`）
- `services/active-message-service.js`（把共享权威与既有事实探针注入 scheduler ctx）
- 测试：`tests/test_active_message_node_convergence.js`（NC1–NC10）
- 上一阶段（浏览器域）：`docs/P25-3C-ACTIVE-MESSAGE-CAPABILITY.md`

---

## 1. Scope

```
（改动前）Node trigger → generateTask/generatePlan → 生成正文 → 直接写 sent 事件（发送）
（改动后）Node trigger → generate… → 生成正文 → **Active Message Authority** → ALLOW
          → 既有出口（事件 / 历史 / windowsNotify）
```

**非目标**（本阶段明确不碰）：重写 / 新建 scheduler、新建消息队列、新建后台服务、
修改 P25-3A Foundation、修改 Diary / Moments / P23 Voice / P24 Group Runtime、
Memory 接入、Middle Brain 接入、Economy 接入、DB migration、commit。

## 2. Phase 0 audit（只读）

| 问题 | 结论（仓库事实） |
| --- | --- |
| A. Node scheduler trigger | `active/scheduler.js` 的 `schedulerTick()`（15s 间隔 + 启动宽限期 `startDelayMs`），以及 HTTP 面 `/tasks/*`（服务进程内的 `executeTask` / `executePlan`） |
| B. `executeTask` / `executePlan` 调用链 | `schedulerTick` → 任务到期 → `executeTask(taskId, scheduledFor)`；`schedulerTick`/HTTP → 计划到期 → `executePlan(planId)` → `evaluatePlan()`（模型二次评估） |
| C. 发送出口在哪 | `executeTask`：生成之后构造 `status:'sent'` 事件（history + `saveNow` + `windowsNotify`）；`executePlan`：`planEvent(claim,'sent',…)` + history + `windowsNotify` |
| D. 是否直接写消息 | **不直接写会话流**：companion 只写自己的持久状态（`events` / `history` / `plans`），浏览器 `_activePullCompanionEvents` 才是 canonical `chatMessages` 的写点（P25-3C 已收敛为唯一 writer） |
| E. 是否直接通知 | 是：`windowsNotify(character_name, content)`（本机通知；测试用 `IB_ACTIVE_DISABLE_NOTIFICATIONS=1` 关闭） |
| F. 是否生成 AI 内容 | 是：`generateProactiveMessage(task)`（最多 `PROACTIVE_MAX_ATTEMPTS=3` + 兜底文案）；计划的二次评估另走 `callCharacterModel` |
| G. 是否已有 cooldown | 有：`adaptiveSkipReason(task)`（“最近 12 小时内刚互动过”顺延）+ 计划侧 `cancelIfUserReplies` / `maxConsecutive` 式抑制（evaluatePlan 内） |
| H. 是否已有 duplicate | 有：`active/model-client.js` 的 `validateProactiveReply`（`PROACTIVE_SIMILARITY_LIMIT=0.82` + 同开头 12 字） |
| I. 是否已有 quiet hour | 有：`_bgAiGateState()`（`state.bgAi.enabled===false` 或 `_bgInSleepWindow` ⇒ `hibernate`）；计划侧另有 `isInDnd/nextDndFree`（规划期） |
| J. identity 来源 | `setting.character_id`（任务）/ `plan.characterId`（计划）；`character.id` 作为快照身份；**不是** nickname |
| K. target 来源 | `setting.user_id` / `plan.user_id`（canonical user id；`armedUsers` 用它做归属门卫） |
| L. 失败语义 | 生成失败 → 兜底文案（仍发送，`generatedByFallback:true`）；不可恢复失败（如角色 API 配置不完整）→ `failed` 事件 + `lastError`；计划按 `maxAttempts` 重试或 `failed` |
| M. 是否已有 canonical event | 事件队列是 companion 的 canonical 交付记录（`events[event_id]` + `history[run_id]`），浏览器按事件镜像落库并 ACK |
| N. 是否与 Browser 共用数据 | 共用同一个持久契约：任务快照（setting + character + recent_*）、计划（含 `prefs`）、事件与历史（浏览器 `_activePullCompanionEvents` 消费） |
| O. 是否存在 direct bypass | **改动前存在**：`executeTask` / `executePlan` 各自"生成完即写 sent 事件"，没有任何发送授权层 ⇒ 本阶段收敛为唯一接缝 |

## 3. Node call graph（收敛后）

```
schedulerTick()                                        （15s / 启动宽限期；时序未改）
  ├─ _bgAiHibernating() → hibernate 时整段跳过（未改）
  ├─ 任务到期 → executeTask(taskId, scheduledFor)
  │     ├─ 既有门卫：armedUsers / enabled / background_enabled / terminalRun / processing 锁
  │     ├─ 既有 cooldown：adaptiveSkipReason(task) → skipped 事件（未改）
  │     ├─ generateProactiveMessage(task) → 失败 ⇒ 兜底文案 / callError（未改）
  │     └─ **P25-3C-Node 接缝**：_sendRequest({...}) → _authorizeSend → 共享 Authority
  │           ├─ DENY  → 任务 skipped 事件（reason: 主动消息被拒绝：<reason>）+ next_run 前进，**不发送**
  │           └─ ALLOW → 既有 sent 出口（事件 / history / saveNow / windowsNotify）—— 逐字未改
  └─ 计划到期 → executePlan(planId)
        ├─ 既有：status/due/late 窗口/executionId 抢占/evaluatePlan（DND→reschedule、用户已回复→cancel、
        │         maxAttempts、连续抑制、模型二次评估）（未改）
        ├─ generateProactiveMessage → 失败 ⇒ 既有重试 15 分钟 / failed（未改）
        └─ **P25-3C-Node 接缝**：_sendRequest({...}) → _authorizeSend → 共享 Authority
              ├─ DENY  → 计划 cancelled + canceled 事件（reason: 主动消息被拒绝：<reason>），**不发送**
              └─ ALLOW → 既有 sent 出口（planEvent('sent') / history / saveNow / windowsNotify）—— 逐字未改
```

## 4. Authority reuse（禁止复制）

| 事项 | 做法 |
| --- | --- |
| 权威实现 | `require('../assets/js/active-message-authority.js')`（**同一份文件**，与 Browser 共用；不新建 `NodeActiveMessageAuthority`） |
| 注入面 | `services/active-message-service.js` 把它作为 `ctx.activeMessageAuthority` 显式注入；未注入时调度器懒加载同一模块 |
| candidate | 复用 `buildActiveMessageCandidate`（Node 只组装 `actorId/targetId/source/trigger/triggerRef/messageRef`；`candidateId` 由共享算法确定性派生） |
| decision | 复用 `runActiveMessageSend`（闭集 allow/deny；顺序 invalid-candidate → unknown-actor → unknown-target → cancelled → disabled → quiet-hours → cooldown → duplicate → allow） |
| 缺席语义 | 权威模块或其 `runActiveMessageSend` 不可用 ⇒ **fail closed**（`deny / authority-missing`），绝不退回"直接发送" |

**facts 全部来自既有 Node 规则**（不新增第二套策略）：

| fact | Node 来源 |
| --- | --- |
| `actorKnown` | `candidate.actorId`（`setting.character_id` / `plan.characterId`）非空 |
| `targetKnown` | `candidate.targetId`（`setting.user_id` / `plan.user_id`）非空 |
| `cancelled` | `false`：失效/取消已由既有 `currentForRun` / `cancelRun` / 计划状态检查在接缝**之前**处理 |
| `enabled` | 任务：`setting.enabled !== false && setting.background_enabled === true`；计划：`plan.prefs.enabled !== false` |
| `quietHours` | `_bgAiGateState() === 'hibernate'`（既有总开关 + 休眠时段；接缝处 **fresh 读**，可捕获生成期间跨过边界） |
| `cooldown` | 任务：`!!adaptiveSkipReason(task)`（既有 12 小时顺延，同一函数）；计划：`false`（`minIntervalMinutes` 是**规划期**约束，发送期不重新施加） |
| `duplicate` | `ctx.validateProactiveReply(content, ctx.recentProactiveMessages(task))`（既有 0.82 / 同开头）；探针缺席 ⇒ `deny / duplicate-probe-missing` |

## 5. Executor boundary

- Node 的"执行"= 既有出口（`status:'sent'` 事件 + `history` + `saveNow` + `windowsNotify`），
  位于接缝**之后**、只有 ALLOW 才会执行；capture 执行体只回执"已授权"，不产生副作用。
- executor **不重新判断** permission / cooldown / duplicate / quiet-hours（这些只有权威裁决一次）。
- 因此 **ALLOW 路径与本阶段之前逐字一致**（NC3/NC3b/NC9 断言 last_sent / next_run_at / 事件 / history 形状不变）。

## 6. Scheduler boundary（冻结）

只改"发送授权接缝"，以下全部未改（NC9 静态 + 动态断言）：`schedulerTick` 的 hibernate 短路、
任务到期判定与 `next_run_at` 推进、`terminalRun` / processing 锁 / `sameRunRevision`、
计划 `late` 窗口与 `expired`、`executionId` 原子抢占、`evaluatePlan` 的全部硬规则与
DND → `reschedule`、生成失败重试（`15 * 60000`）与 `maxAttempts`、历史裁剪、启动宽限期、
15 秒 tick、`prefillSeed` 解析契约。

## 7. Identity

- `actorId` = `setting.character_id` / `plan.characterId`（canonical role id；**不是** `nickname`）；
- `targetId` = `setting.user_id` / `plan.user_id`（canonical user id；同样是 `armedUsers` 的归属键）；
- `candidateId` 由共享权威确定性派生（`amc_` + stableToken），Node 不发明身份；
- 消息 id 仍由 domain 持有（`messageId(taskId, scheduledFor)` / `planMessageId(planId, sentAt)`）。

## 8. Canonical event boundary（禁止 Node + Browser 双写）

| 层 | 写什么 | 谁写 |
| --- | --- | --- |
| Node companion | `events[event_id]` / `history[run_id]` / 任务 `recent_proactive_messages` / 计划状态 | `active/scheduler.js`（既有） |
| Browser | canonical `chatMessages`（唯一 writer `_activeWriteCanonical`，`effects:false` 镜像） | `_activePullCompanionEvents`（P25-3C 已收敛） |

Node **不写** `chatMessages`；浏览器**不**重新裁决发送权限（它镜像的是"已授权 + 已发送"的事件）。
两层各自只写自己的 canonical 面 ⇒ 不存在双写。

## 9. Tests（NC1–NC10）

`tests/test_active_message_node_convergence.js`（13 个 test、全绿）用**真实 service 执行链**
（隔离 `IB_ACTIVE_DATA_DIR` + `global.fetch` 场景桩 + 在模块对象上装权威探针）：

| NC | 覆盖 |
| --- | --- |
| NC1 / NC1b | 任务与计划触发都到达共享权威（candidate 的 actorId/targetId/source/trigger/triggerRef + facts） |
| NC2 / NC2b | DENY ⇒ 任务 skipped（next_run 前进、last_sent 不变、零额外模型调用）/ 计划 cancelled + canceled 事件，**零发送** |
| NC3 / NC3b | ALLOW ⇒ 恰好一次发送（sent 事件 + history + last_sent；计划 → waiting_for_user） |
| NC4 | 无直发旁路：唯一接缝（`runActiveMessageSend` 仅"探测 + 一个调用点"，且 `'sent'` 事件只在授权之后构造）+ 权威缺席 ⇒ fail closed（skipped/cancelled with `authority-missing`） |
| NC5 | 冷却仍是既有 12 小时规则（生成前生效、零模型调用；接缝喂同一函数），实现未改 |
| NC6 | 去重仍是既有 0.82 + 同开头规则（scheduler 内零相似度实现；既有 dedup 场景仍走生成期重试/兜底；探针缺席有 fail-closed 分支） |
| NC7 | 身份只用 canonical id（不是昵称 / displayName） |
| NC8 | failure ≠ deny：模型失败走既有兜底后仍经权威发送；不可用状态走既有 `failed` 且**不经过**权威 |
| NC9 | 调度时序 / claim / retry / 免打扰语义未改（+ ALLOW 路径 last_sent/next_run_at 语义一致） |
| NC10 | Browser 侧逐字节未变（active-message-authority / active-diary.js / active-plans.js / adapter 哈希）+ Browser 套件仍登记 |

## 10. Guards（本阶段结束时）

| 对象 | 结论 |
| --- | --- |
| `assets/js/active-message-authority.js` | 逐字节未变 `CC2A8BF9…AE3892C4`（Node 复用，不复制） |
| `assets/js/active-diary.js` | 逐字节未变 `D14D4AC6…89ADE8CA` |
| `assets/js/active-diary/active-plans.js` | 逐字节未变 `7975ADBD…245CE860` |
| `assets/js/agent-orchestration-active-message-adapter.js` | 逐字节未变 `C1984C7F…988C0DEE` |
| Diary / Moments / P23 / P24 / Foundation | 逐字节未变（见 P25-3C 文档 §18 与各阶段冻结清单） |
| `active/plan-domain.js` | 逐字节未变 `55BEE8AA…796BDAD6` |

改动：`active/scheduler.js`（接缝 + 两个调用点）、`services/active-message-service.js`（ctx 注入三行 + require 一行）。

## 11. Known limitations

1. **生成发生在裁决之前**：DENY 时已消耗一次生成调用（选择单点裁决而非双裁决；
   代价一次生成，收益是"同一个权威只有一个调用点"）。
2. **deny 的呈现**：任务用 `skipped`、计划用 `cancelled`（沿用两层既有的"策略跳过/取消"形状），
   不新增状态词；浏览器侧因此显示"已顺延 / 已取消 + 原因"。
3. **计划发送期不再施加 DND / minInterval**（既有语义是规划期约束），与 Browser 侧同结论。
4. **executor 失败**仍走各层既有失败路径（任务：兜底文案；计划：`maxAttempts` / `failed`），
   接缝不引入通用 retry / rollback。
5. **`windowsNotify`（本机通知）不重新设计**：仍在 ALLOW 之后的既有出口内触发。
6. **companion 与浏览器仍是两个进程**：本阶段统一的是**发送权限**（同一权威）与写入面
   （各自只写自己的 canonical 面），没有把 companion 并进浏览器进程。

## 12. Deferred work

- 事件队列的幂等/去重（当前依赖 `event.id` / `run_id` 与浏览器 `message_id` 检查）。
- companion 侧 `active_message.delete` / 历史清理的权限面。
- 计划发送期的 DND 语义统一（需产品决策）。
