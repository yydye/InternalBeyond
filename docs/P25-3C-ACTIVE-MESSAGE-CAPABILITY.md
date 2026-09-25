# P25-3C · Active Message Capability Integration

状态：**Active Message Capability INTEGRATED（浏览器域）**。主动消息的**发送权限**第一次
离开 scheduler / model / Middle Brain / executor，成为独立权威；设定计划、AI 计划、
手动“立即发送”三条生产路径共用**同一个** Active Message Authority 与**同一条** canonical writer。
P25-3A 编排契约与 P25-3B Diary 全部零修改。

实现位置：

- `assets/js/active-message-authority.js`（唯一发送权限：candidate → decision → 仅 ALLOW 才执行）
- `assets/js/agent-orchestration-active-message-adapter.js`（`active_message.send` descriptor + route + verifier）
- `assets/js/active-diary.js`（生产收敛：`_activeSendAuthorized` / `_activeWriteCanonical` 接缝 + 唯一 chatMessages 写点）
- `assets/js/active-diary/active-plans.js`（AI 计划路径复用同一条接缝）
- `InternalBeyond.html`（加载 `active-message-authority.js`；**不**加载编排 adapter —— 编排层仍是 foundation-only）
- 测试：`tests/test_active_message_authority.js`（AM1–AM18）、
  `tests/test_agent_orchestration_active_message_adapter.js`（OA1–OA12 + PC1–PC10）

---

## 1. Scope

把既有的主动消息链：

```
scheduler / event → character decision（模型）→ send（写 chatMessages + 通知）
```

收敛为：

```
Trigger → Active Message Candidate → **Active Message Authority** → ALLOW
        → Active Message Executor → Canonical Chat Writer → Verify
```

并注册 `active_message.send`。**本阶段不引入**：新 schema、DB migration、新消息队列、
新 scheduler、新后台服务、Memory 接入、Middle Brain 接入、Voice/TTS 迁移、
通知系统重设计、P23 / P24 / Autonomy Core / Moments / Diary 修改。

## 2. Phase 0 audit（只读）

| 问题 | 结论（仓库事实） |
| --- | --- |
| A. 入口在哪 | 浏览器 `assets/js/active-diary.js`（设定计划 + companion 事件镜像）+ `assets/js/active-diary/active-plans.js`（AI 计划）；Node companion `services/active-message-service.js` + `active/scheduler.js` |
| B. 所有 trigger | 定时到期（`_activeTick` → `_activeClaimDue`）、AI 计划到期（`_activeTickAiPlans`）、用户显式“立即发送”（`_activeRunNow` → `manual:true`）、companion 事件回传（`_activePullCompanionEvents`） |
| C. 谁决定 send / skip | **改动前**：模型输出（生成成功即落库）+ 若干分散闸门（`setting.enabled` / `_bgAiGate()` / `_activeAdaptiveReason` / 计划状态机 / `_activeValidateProactiveReply`）。**改动后**：Active Message Authority |
| D. 模型是否参与 | 是（`generateProactiveMessage` → `_activeProactiveModelCall` → runtime.execute / callApiChat），最多 3 次尝试后使用兜底文案 |
| E. 模型输出结构 | 可见正文文本（+ 可选 reasoning 元数据）；**正文不是权限** |
| F. send writer 在哪 | **改动前 3 处**：`_activeStoreMessage`（设定计划）、`_activeStoreAiPlanMessage`（AI 计划）、`_activePullCompanionEvents`（companion 镜像）。**改动后 1 处**：`_activeWriteCanonical` |
| G. message persistence 调用点 | `chatMessages`（会话流，canonical）+ `active_message_history`（发送记录）+ `active_message_settings` / `active_message_plans`（调度状态）—— 后三者是**记账**，不是发送 |
| H. notification 调用点 | `_activeNotify`（浏览器 `Notification` API，仅 granted + 非当前会话时）；无 push 服务 |
| I. retry | 有：`ACTIVE_PROACTIVE_MAX_ATTEMPTS=3`（生成期重试，带 250ms/500ms 退避）；计划有 `maxAttempts` 状态机重试。本阶段**不新增**通用 retry |
| J. duplicate protection | 有：`_activeValidateProactiveReply`（相似度 `ACTIVE_PROACTIVE_SIMILARITY=0.82` + 同开头 12 字）；语音呼入另有 `isDuplicateEvent` |
| K. cooldown | 有：`_activeAdaptiveReason`（“最近 12 小时内刚互动过，本次计划已顺延”）+ 计划期 `minIntervalMinutes`（默认 30 分钟，硬下限 5 分钟） |
| L. quiet hours | 有：BG-AI 总开关 + 休眠时段（`apiSettings['bgAi'] = {enabled,sleepStart,sleepEnd}` → `_bgAiGate()==='hibernate'`）；AI 计划另有 `dndStart/dndEnd`（`_activeIsInDnd`，默认 23:00–08:00） |
| M. user preference | 有：`setting.enabled` / `background_enabled` / `adaptive_enabled` / `frequency`、`ib_active_ai_prefs_v1`（enabled / mode / minIntervalMinutes / maxPlanHours / maxConsecutive / dnd / cancelIfUserReplies / allowReschedule） |
| N. manual user message bypass | 用户自己发消息是 `communication.js` 的普通聊天（**不是**本能力）；本能力里的“用户请求”只有 `_activeRunNow`（“立即发送”），既有语义是 `manual:true`（跳过自适应顺延） |
| O. AI generated message | 存在（设定计划的模型文案 + AI 计划的计划文案 + 兜底文案） |
| P. identity | setting id = `active_<time36>_<rand>`；plan id = `proactive_<time36>_<rand>`；**消息 id = `active_msg_<setting|plan>_<秒级时间>`（domain 持有）**；run id = `active_run_<setting>_<ms>` |
| Q. delivery 是否有 canonical writer | **改动前没有**（3 个写点各自 `dbPut('chatMessages')`）。**改动后有**：`_activeWriteCanonical(msg,opts)` 是唯一写点 |
| R. 失败语义 | 生成失败 → 3 次尝试后兜底文案；发送失败 → `_activeFinishRun(run,null,error)`（history `failed`），手动时提示用户；**失败 ≠ 权限拒绝** |
| S. voice/TTS side effect | 语音呼入计划（`interaction==='voice_call'`）不写会话流，改为生成短开场词 + 交互事件 + 来电 UI（`_activeOfferVoiceCall` → `NS.voiceCall.offerIncoming`），交付由既有 Voice Runtime 承担 —— 本阶段**不迁移** |
| T. companion direct send | **存在**（Node 独立运行时：`active/scheduler.js` 的 `executeTask` / `executePlan` → `status:'sent'` 事件 → 浏览器 `_activePullCompanionEvents` 镜像落库）。见 §21 |

## 3. Trigger 分类（§6）

| 分类 | 是否存在 | 实例 |
| --- | --- | --- |
| MANUAL_USER_MESSAGE（用户自己发消息） | **NOT PRESENT**（属于普通聊天，不是 Active Message 能力） |
| USER_REQUESTED_MESSAGE | PRESENT | `_activeRunNow`（“立即发送”，`manual:true`，source `user`） |
| AUTONOMOUS_MESSAGE | PRESENT | 设定计划到期（source `schedule`）、AI 计划到期（source `plan`） |
| SYSTEM_MESSAGE | PRESENT | BG-AI 调度器 / 计划状态机的系统触发（与上面同源路径） |
| MIGRATION | **NOT PRESENT** | 无迁移入口 |

## 4. Candidate 契约

```
{
  candidateId,   // 'amc_' + stableToken(actorId|targetId|source|trigger|triggerRef)
  actorId,       // 角色 canonical id（apiConfigs/archivedConfigs 的 id）
  targetId,      // 目标用户/会话 canonical id（setting.user_id / plan.user_id / _activeUserId()）
  source,        // 'schedule' | 'plan' | 'character' | 'user' | 'companion'
  trigger,       // 'schedule' | 'ai_plan' | 'manual' | 'companion' | …
  triggerRef,    // setting id / plan id / run id
  messageRef,    // canonical message id（domain 持有，本层只引用）
  contextRef     // 可选上下文引用（非正文）
}
```

## 5. Identity Boundary（§9）

- `actorId` = 角色 canonical id（**不是**昵称、**不是** displayName、**不是** provider/model）；
- `targetId` = canonical user/session id（`setting.user_id` / `plan.user_id`，缺失时回落 `_activeUserId()`；
  `_activeUserId()` 自身持久化在 `localStorage['ib_active_user_id']`，永不返回空）；
- 消息 id 仍由 domain 持有（`active_msg_*`）——**编排层不重新发明消息身份**，只透传 `idempotencyKey`；
- `candidateId` 是纯派生身份（`chat-core.stableToken`），确定性、可重放、不含 `Math.random` / `Date.now`。

## 6. Authority 契约

`assets/js/active-message-authority.js`（纯 UMD，浏览器 + Node 双挂载 `IBActiveMessageAuthority`）：

| 导出 | 作用 |
| --- | --- |
| `buildActiveMessageCandidate(input)` | 校验并构造 candidate（`{ok, candidate, errors}`） |
| `decideActiveMessageSend(candidate, facts)` | 纯决策：`{decision, reason}` |
| `runActiveMessageSend(candidate, facts, executor)` | 唯一入口：DENY ⇒ 不调用 executor；ALLOW ⇒ 执行恰好一次 |
| `verifyActiveMessageSend(result, reader)` | 只验证 canonical message 存在（reader 注入），不补发、不 retry、不改状态 |

## 7. Decision 语义（§11）

闭集 `allow` / `deny`（**无 DEFER**：被动“稍后”语义已由既有 `next_run_at` / `scheduledAt` 承担）。
判定顺序逐条 fail closed：

```
invalid-candidate → unknown-actor → unknown-target → cancelled
→ disabled → quiet-hours → cooldown → duplicate → allow
```

executor 缺席 ⇒ `no-executor`（DENY）；authority 模块缺席 ⇒ domain 侧 fail closed
（`_activeRunSend` 返回 `deny / authority-missing`），**绝不**退回旧直写。

## 8. Facts（只读自真实状态；规则仍然只有一份）

| fact | 规则来源（既有实现，未改写） |
| --- | --- |
| `actorKnown` | cfg 解析成功且未归档 |
| `targetKnown` | `targetId` 解析成功（含 `_activeUserId()` 回落） |
| `cancelled` | 调用方传入（计划状态机 / 取消语义） |
| `enabled` | 设定计划 = `setting.enabled`；AI 计划 = `_activeAiPrefs().enabled`；manual = true（见下） |
| `quietHours` | 设定计划 = `_bgAiGate()==='hibernate'`（BG-AI 总开关 + 休眠时段，`_bgInSleepWindow`）；AI 计划 = false（DND 是**规划期**约束：`_activeNextDndFree` / `respectDoNotDisturb`） |
| `cooldown` | 设定计划 = `_activeAdaptiveReason(setting)`（12 小时互动顺延）；AI 计划 = false（`minIntervalMinutes` 是**规划期**约束） |
| `duplicate` | `_activeValidateProactiveReply(content, recentProactive)`（既有相似度 0.82 / 同开头规则） |

**manual 覆盖（显式登记，不是 bypass）**：`_activeRunNow` 的 `manual:true` 沿用既有产品语义
（与 `_activeExecuteRun` 的 `if(!run.manual)` 同源）⇒ facts 取 `enabled:true / quietHours:false /
cooldown:false / duplicate:false`。它**仍然**经过同一条 authority 与同一条 canonical writer，
因此不是绕过：拒绝/放行仍然由 authority 记录。

## 9. Frequency / Cooldown / Quiet hours / Duplicate（§12/§13）

- **频率**：设定计划用 `next_run_at`（`_activeNextRun`；weekly / interval / daily）+ 日/周水位线；
  AI 计划用 `scheduledAt` + `minIntervalMinutes` + `maxConsecutive` + `maxPlanHours`。
  **未新增第二套**，也**未重写** planner。
- **冷却**：既有 `_activeAdaptiveReason`（12 小时）在**生成前**跳过（省一次模型调用），
  并在**写入时刻**用同一函数复核（生成期间用户回话 ⇒ 本次不发送）。
- **免打扰**：BG-AI 休眠时段在 tick 入口早退（既有行为），并在写入时刻复核
  （跨越边界 ⇒ 本次不发送）。AI 计划的 DND 只在规划期施加（保持既有语义）。
- **去重**：唯一实现仍是 `_activeValidateProactiveReply`（相似度 0.82 + 同开头 12 字），
  本阶段**没有**新增 duplicate store、没有新增指纹。

## 10. Scheduler / Model / Executor / Writer 边界

- **Scheduler**：只回答 when（到期判定、水位线、`next_run_at`）。tick 体内**没有** `dbPut('chatMessages')`。
- **Model**：只产正文（content）；正文不参与 decision（candidate 不含正文；`decideActiveMessageSend`
  函数体内零 `content` / `draft` 引用，AM12 用源码切片钉住）。
- **Executor**：只执行已授权发送（`async () => { await _activeWriteCanonical(msg,{cfg}); return {ok:true,message:msg} }`），
  不重判 enabled / quiet-hours / cooldown / duplicate；执行失败 ⇒ `decision:'allow', executed:true, ok:false`
  （**不是** DENY，AM11）。
- **Canonical Writer**：`_activeWriteCanonical(msg,opts)` 是本域唯一 `chatMessages` 写点
  （静态守卫：`active-diary.js` / `active-plans.js` 里 `dbPut('chatMessages'` 只出现 **1** 次，且位于该函数内）。
  `opts.effects=false` 用于 companion 投递镜像（它自带那一步的既有副作用）。

## 11. Delivery 边界（§18）

| 通道 | 归属 | 本阶段动作 |
| --- | --- | --- |
| 会话流 `chatMessages` | Active Message canonical writer | 收敛为唯一写点（本次） |
| 系统通知 `Notification` | `_activeNotify`（既有） | **不改**；只在写入成功后触发 |
| 语音 / TTS | P23 Voice Runtime + `NS.voiceCall` | **不迁移**（voice_call 计划只发交互事件） |
| companion 事件队列 | Node companion（独立运行时） | 只作为**投递镜像**接入同一 writer |

## 12. Verify 契约（§19）

`verifyActiveMessageSend(result, reader)`：

| 情况 | 结果 |
| --- | --- |
| 未完成 / `ok !== true` | `not-completed` |
| 无可验证 message id | `missing-message-id` |
| canonical 行不存在 | `canonical-message-missing` |
| 归属不符（`friendId` ≠ actor） | `identity-mismatch` |
| 行不是主动消息（`source` ≠ `active_message`） | `not-an-active-message` |
| 存在且归属正确 | `{verified:true, messageId}` |

只读（reader 注入）：**不补发、不 retry、不改状态**。

## 13. Registry + Adapter

descriptor（遵守 P25-3A frozen descriptor）：

```
{ id:'active_message.send', domain:'active_message', kind:'action',
  description:'请求向指定用户发送一条主动消息（经 Active Message Authority 裁决）',
  sideEffect:'local', authorityType:'domain', binding:'active_message.send' }
```

`assets/js/agent-orchestration-active-message-adapter.js`：
`registerActiveMessageCapabilities` / `createActiveMessageOrchestrationAdapter({authority,domain,reader})` /
`invokeAuthority`（只捕获已授权意图）/ `resolveExecutor`（同一步第二次执行被拒 `executor-called-twice`）/
`idempotencyKeyFor`（透传 candidateId 或调用方 key）/ `verify`（async，绑 `verifyActiveMessageSend`）/
`describeActiveMessageAvailability`（只回答基础设施可用性，**不是**权限）。
Adapter 零 DB / DOM / fetch / 模型 / Notification / TTS（OA4/OA5 断言）。

## 14. Production Convergence（§23）

改动前（三个独立写点 + 分散闸门）：

```
_activeTick → _activeClaimDue → _activeExecuteRun → _activeGenerate → _activeStoreMessage → dbPut('chatMessages')
_activeTickAiPlans → _activeExecuteAiPlan → generateProactiveMessage → _activeStoreAiPlanMessage → dbPut('chatMessages')
_activePullCompanionEvents → dbPut('chatMessages')   ← companion 投递镜像
```

改动后（同一条权威 + 同一条 writer）：

```
（设定计划）_activeTick → _activeClaimDue → _activeExecuteRun → _activeGenerate
            → _activeSendAuthorized → **Authority** → ALLOW → _activeWriteCanonical → （记账）_activeFinishRun
（AI 计划）_activeTickAiPlans → _activeExecuteAiPlan → generateProactiveMessage
            → _activeStoreAiPlanMessage → _activePlanSendAuthorized（NS.active.sendAuthorized）
            → **Authority** → ALLOW → _activeWriteCanonical
（手动）    _activeRunNow → _activeExecuteRun(manual) → … 同上（facts 走 manual 覆盖）
（投递镜像）_activePullCompanionEvents → _activeWriteCanonical(effects:false)   ← inbound，不重复裁决发送权限
```

DENY 语义（既不静默重试、也不换通道）：

- 设定计划：`_activeStoreMessage` 返回 null ⇒ `_activeExecuteRun` 走 `_activeSkipRun(run, '本次主动消息被 Active Message Authority 拒绝')`
  （history `skipped`，不写消息、不推进 `last_sent`，`next_run_at` 照常顺延）；
- AI 计划：`_activeStoreAiPlanMessage` 返回 `{ok:false}` ⇒ 计划标记 `cancelled` + `cancelReason='主动消息被拒绝：<reason>'`，
  不写发送历史、不写消息；
- 权威模块缺席：两侧都 fail closed（`authority-missing`），零写入（PC2 动态断言）。

## 15. Double Authority（§24）

**不实现** authorized-execution-envelope bypass，与 P25-3B 同结论：

1. 生产写入入口（`_activeSendAuthorized`）同时服务设定计划 / 手动 /（经 `NS.active`）AI 计划，
   一个“只有编排层能打开”的旁路写面会制造第二套发送权威（禁止）；
2. 编排预检查与 domain 内裁决调用的是**同一个** authority、**同一份** facts，
   都是 fail-closed ⇒ 第二次不可能放宽第一次的结论；
3. 代价：多一次纯函数裁决（无 IO、无副作用）。收益：scheduler 与 orchestrator 不共享任何可绕过的写面。

## 16. Companion Runtime 边界（§4-T：P25-3C 枚举，**P25-3C-Node 已收敛**）

> 后续状态（P25-3C-Node，见 `docs/P25-3C-NODE-ACTIVE-MESSAGE.md`）：companion 的
> `executeTask` / `executePlan` 已接入**同一个** Active Message Authority（同一份
> `assets/js/active-message-authority.js`），facts 仍由既有 Node 闸门产出
> （BG-AI 休眠 / `adaptiveSkipReason` 12 小时 / model-client 0.82 去重）。
> 本节保留 P25-3C 当日的审计结论与理由，作为阶段边界的历史记录。

Node companion（`services/active-message-service.js` + `active/scheduler.js`）是一个**独立持久运行时**：
`schedulerTick` → `executeTask`（设定计划）/ `executePlan`（AI 计划）→ 生成正文 → 写入
`status:'sent'` 事件队列 → 浏览器 `_activePullCompanionEvents` 镜像进 canonical 会话流。

本阶段**只收敛浏览器域**（canonical 会话流的真正写点），理由：

1. 浏览器 `background_enabled` 为本机后台服务显式委托：伴随运行时由
   `active/scheduler.js` 自带 `_bgInSleepWindow` / `_bgAiGateState` / `adaptiveSkipReason` / 计划评估闸门；
2. 接入它需要改动 Node scheduler 的发送发射点（`executeTask` / `executePlan`）与
   companion 的持久状态机 —— 那属于"第二套运行时收敛"，与本阶段"不重写 scheduler"、不新增服务的约束冲突；
3. 因此把它**枚举**并登记为 deferred（见 §20），而不是静默跳过：浏览器侧的镜像写入**不是**
   新发送决策（已由 companion 判定 + 已发送），所以不在这里重复裁决发送权限。

**这仍是本阶段唯一的未收敛出站运行面**，已在报告中作为 Known limitation 明确写出。

## 17. Cancellation / No-CoT / Secret / Memory / MB

- **Cancellation**：沿用 P25-3A 合同（`isCancelled()` ⇒ 后续 step `denied/cancelled`，不重发）；
  facts 支持 `cancelled`；发送成功后不回滚已产生的外部影响（无通用 rollback）。
- **No-CoT**：candidate / facts / authority 结果 / adapter 结果 / verifier 结果中零
  thinking / analysis / rationale / scratchpad / chain_of_thought（AM18 / OA12b）。
  主动消息**正文**不是 CoT：正文不进 candidate、不被扫描剔除。
- **Secret**：candidate 整对象经 `voice-message-core.findSecret` 扫描（命中 ⇒ `secret-in-candidate`）；
  authority / adapter / descriptor / 结果均零 `apiKey` / `authorization` / `credential` / provider 配置（AM17）。
- **Memory guard**：零新增 Memory authority import、零 Memory capability、零 Orchestrator→Memory 边、
  零 Active Message→Memory writer（AM15 / OA12b）。
- **Middle Brain guard**：零新增 MB authority、零 MB side effect（AM16 / OA12b）；
  MB 未来只能提供 recommendation / context。

## 18. Frozen Guards

P25-3C 结束时逐字节未变：

| 文件 | SHA-256 |
| --- | --- |
| `assets/js/autonomy-core.js` | `FE1011F1…9F2956F8` |
| `assets/js/communication.js` | `DEB568A2…AC29184F` |
| `assets/js/group-runtime-core.js` | `6F30FDE9…067B35E8` |
| P23 五核（delivery-planner / multimodal-delivery-policy / delivery-sequence-core / delivery-runtime / voice-message-core） | `15E7DBD0…` / `B7AFDFA6…` / `5AE59648…` / `82BC57D7…` / `06907AA2…` |
| `assets/js/moments.js` | `E23697DE…B82CEE31` |
| `assets/js/moments-autonomy.js` | `A4CEE6DA…C843CD1A` |
| `assets/js/moments-mutation-authority.js` | `1FBB1E12…2FB5A056` |
| `assets/js/moments-semantic-core.js` | `FECCDA5E…B72DA7B7` |
| `assets/js/diary-authority.js` | `BBB7EC88…C95E73A9` |
| `assets/js/active-diary/diary.js` | `86C355D6…702B16DA` |
| `assets/js/agent-capability-registry.js` | `78AE9DFE…273BF7A2` |
| `assets/js/agent-orchestration-core.js` | `BA4A3DFA…AC204F79` |
| `assets/js/agent-orchestration-moments-adapter.js` | `DA2506B9…EC6BD466` |
| `assets/js/agent-orchestration-diary-adapter.js` | `7D98217B…34AA9805` |
| `services/active-message-service.js` | `B8674982…C005FE5B` |
| `active/scheduler.js` | `16A39FA8…5655881E`（未改动，companion 运行时保持原样） |
| `active/plan-domain.js` | `55BEE8AA…796BDAD6`（未改动） |

改动（P25-3C）：

| 文件 | SHA-256 | 性质 |
| --- | --- | --- |
| `assets/js/active-message-authority.js` | `CC2A8BF9…AE3892C4` | 新增（纯权威） |
| `assets/js/agent-orchestration-active-message-adapter.js` | `C1984C7F…988C0DEE` | 新增（adapter，未加载进页面） |
| `assets/js/active-diary.js` | `D14D4AC6…89ADE8CA` | 收敛（唯一 canonical writer + authority 接缝；997/1013 行号豁免区未位移） |
| `assets/js/active-diary/active-plans.js` | `7975ADBD…245CE860` | 收敛（复用同一接缝） |
| `InternalBeyond.html` | `08AF54D8…592EFB9F` | 加载 `active-message-authority.js` |
| `tests/test-all.js` | `007E2B1F…1C31E0DC` | 注册两个新套件 |
| `tests/test_runtime_integration_audit.js` | `E8D7CFFA…FBD6E77E` | companion ingest 审计片段补上 canonical writer（P25-3C 收敛的必然结果） |

`DB_VER`：24 → 24（未变）；Moments / Diary schema 未动。

## 19. Tests

| 套件 | 覆盖 |
| --- | --- |
| `tests/test_active_message_authority.js` | AM1–AM18：candidate / 判定顺序 / 无 DEFER / 执行力 / verifier / 纯度（DB·DOM·模型·Memory·MB·通知·TTS）/ 秘密 / CoT / 确定性身份 / domain 策略与单一 writer |
| `tests/test_agent_orchestration_active_message_adapter.js` | OA1–OA12（注册 / descriptor / 路由 / Plan != Permission / DENY 零执行 / verifier / 取消 / 幂等透传 / 结果规范化）+ PC1–PC10（真实 `active-diary.js` + `active-plans.js` 生产收敛） |

PC 段在 vm 沙箱里加载**真实生产文件**并驱动**真实 scheduler**：
`_activeTick → _activeClaimDue → _activeExecuteRun → _activeGenerate → authority → canonical writer`，
用内存 store + 最小 IndexedDB 事务桩替代浏览器存储；不触网、不写真实数据库。

PC 覆盖：PC1 scheduler 经 authority；PC2 旧直写消失 + 权威缺席 fail closed；
PC3 ALLOW 恰好一条 + 读口/气泡一致；PC4 写入时刻免打扰 DENY（零写入、history `skipped`）；
PC5 冷却（生成前顺延 + 写入时刻复核）；PC6 去重（既有相似度规则）；PC7 免打扰（BG-AI 闸门）；
PC8 用户偏好（`setting.enabled` / BG-AI 总开关 / manual 覆盖语义）；PC9 既有 UI 与导出面；
PC10 会话流形状 + `_activeRecentProactiveMessages` 读口 + companion 投递镜像（不经发送裁决）。

## 20. Known limitations / Deferred work

**Known limitations**

1. **Node companion 出站运行面**：P25-3C 只收敛浏览器域（本条为当日状态）；
   **P25-3C-Node 已把它收敛到同一权威**（`active/scheduler.js` 的 `executeTask` / `executePlan`
   先过 Active Message Authority，ALLOW 才走既有出口）——本条现为历史记录。
2. **手动“立即发送”走 facts 覆盖**（`enabled/quiet/cooldown/duplicate=false`）：沿用既有产品语义
   （用户显式点击 ≠ 自动调度），已在 §8 显式登记；authority 仍记录该次决策。
3. **AI 计划的 DND / minInterval 仍是规划期约束**：发送期不重新施加（避免把调度期约束变成发送期否决，
   那会是新增产品策略）。
4. **生成发生在裁决之前**：DENY 时已消耗一次模型调用（选择单点裁决而非双裁决；
   代价是一次生成，收益是"同一个 authority 只有一个调用点"）。
5. **`_activeNotify` / 系统通知未重新设计**：仍在写入成功后按既有条件触发。
6. **语音呼入计划不写会话流**：其交付归 P23 Voice Runtime，本阶段不动。
7. **编排 adapter 未加载进页面**：`active_message.send` 只被 descriptor/测试使用，生产触发仍走 domain 路径。
8. **verifier 绑定是 async**（canonical 读是异步的），未修改 P25-3A 的同步 `verifyStepResult` contract。

**Deferred work**

- ~~`P25-3C-Node`：companion 运行时的发送收敛~~ —— **已完成**（见 `docs/P25-3C-NODE-ACTIVE-MESSAGE.md`）。
- `active_message.delete` / `read` 能力与历史清理权限。
- AI 计划发送期的 DND 语义统一（需要产品决策，不属本阶段）。
- 主动消息的正式幂等键（当前 candidateId 只透传，不落盘）。
