# P27-0 · Activity Production Wiring Audit

阶段性质：**PRODUCTION INTEGRATION PRE-AUDIT / READ-ONLY / EVIDENCE-FIRST /
NO PRODUCTION MUTATION / NO SCHEMA CHANGE / NO COMMIT**。

上游冻结：P23 Delivery（LOGICALLY FROZEN）· P24 Group Runtime（COMPLETE）·
P25 Autonomy / Unified Agent Orchestration（FROZEN）· P26 Runtime Architecture
（CLOSURE: PASS WITH NOTES / LOGICALLY FROZEN）。

本阶段**只读审计**：Activity 当前生产架构，以及 P27-1..5 应该在哪里接线。
**P27 暂不接 P26-5..10**（无 production consumer）；P27 只验证 **P26-1..4**。

---

## 1 State

**P27-0 State: PASS WITH NOTES**

- P26-1..4 在 Activity 上**有真实且安全的接线点**（created 事件；Cinema/Co-read observation；session 可投影；resource 暂无真实冲突）。
- **不需要**新的 canonical writer（`IB.activity` 已是唯一 writer）。
- **不需要** DB migration / DB_VER bump / new store。
- **不需要** Event Bus / Observation Manager / Session Manager / Resource Manager。
- Notes：`activity.finished` 与 `activity.deleted` **今天不是可发事实**（无 writer / 无调用者）；
  P27-5（Resource）建议 **DEFER**。

## 2 Repository Reality

真实文件与调用链（按实际调用，不按文件名猜）：

| 对象 | 真实位置 | 角色 |
| --- | --- | --- |
| Activity 运行时 | `assets/js/activity/activity-runtime.js`（312 行，`IB.activity` / `window.IBActivity` / `window._activityCreate`） | **唯一 canonical writer** + current 指针 + context 投影 |
| Co-read App | `assets/js/activity/coread.js` | 只调用 `IB.activity.*`（find/create/setCurrent/setProgress/saveActivity/send/writeMemory/nudge/clearCurrent） |
| Cinema App | `apps/ib-app-cinema.js` | 经 `IBApps` 注册，**不在 HTML 静态加载**；调用 `IB.activity.*` |
| Media 传输适配器 | `apps/ib-media-adapter.js`（`IBMedia.resolveMedia / createAdapter`） | 播放传输（load/play/pause/seek/getCurrentTime/getDuration/destroy） |
| 聊天侧钩子 | `assets/js/communication.js` | `getActivityContext` 注入 + `metadata.activityId` 归属 + `_ibAppBroadcast` |
| 存储 | IndexedDB `activities`（`core.js`，索引 `byRole`/`byType`）；localStorage `ib_activity_current_v1` | canonical + pointer |
| 既有测试 | `tests/test_activity_smoke.js`（T1–T9 + legacy，浏览器） | 行为保护 |

**加载方式（证据）**：`InternalBeyond.html` 静态加载 `activity-runtime.js` 与 `coread.js`；
`apps/ib-app-cinema.js` **不**在 HTML 中，而是由 `apps/catalog.js|json` 的
`"file":"ib-app-cinema.js"` 经 App Store 惰性注入（`apps/` + file）。

## 3 Canonical Storage

| 层 | 载体 | 是否 canonical | 说明 |
| --- | --- | --- | --- |
| **Canonical record** | IndexedDB **`activities`**（keyPath `id`；索引 `byRole`(roleId) / `byType`(type)） | **YES（唯一）** | 写入者只有 `IB.activity`（见 §4） |
| **Current pointer** | localStorage **`ib_activity_current_v1`**（每角色一个 `{activityId, at}`） | **NO**（自述"不是 authority"，可重建） | 丢失时按 `status!=='finished'` + `lastActiveAt` 最新确定性回退 |
| **Runtime state** | App 内 JS（Cinema `_activity/_aiId/subs/_lastCue/media adapter`；Co-read `_book/_pages/_pi/_bm`） | NO | 进程内存，不持久 |
| **UI state** | DOM（`#ci-*` / `#cr-*` 容器、typing、弹幕层、进度条） | NO | 表现层 |

**canonical record ≠ current pointer ≠ runtime state ≠ UI state**（四者互不等价，已逐条验证）。

record 形状（`createActivity` 写入）：`{ id:'act_<now>_<rand>', type, roleId, resourceId, resourceKey,
title, kind, threadId:null, progress, bookmarks, recap, config, status:'active', createdAt, updatedAt,
lastActiveAt }`（`lastNudgeAt` 由 `nudge` 追加）。

## 4 Writer Map

| 类别 | 真实入口 | 写什么 | 状态 |
| --- | --- | --- | --- |
| CREATE | `IB.activity.createActivity()` ← Cinema `_loadMedia` / Co-read `coreadOpen` | 新 `activities` 行（`status:'active'`） | PRESENT |
| UPDATE | `IB.activity.saveActivity(id, patch)` | 任意字段 + `updatedAt` | PRESENT（内部亦被 setProgress/nudge 使用） |
| PROGRESS | `IB.activity.setProgress()` ← Cinema `_pushProgress`（1.5s 节流）/ Co-read `_saveProgress`（翻页） | `progress` + `lastActiveAt` | PRESENT |
| BOOKMARK | `IB.activity.saveActivity(id,{bookmarks})` ← Co-read `_toggleBm` | `bookmarks` | PRESENT |
| MEMORY | `IB.activity.writeMemory()` → `quickCreateMemory` | **不写 `activities`**（写 `memories`，属 Memory 域） | PRESENT（委托） |
| NUDGE | `IB.activity.nudge()` ← Cinema/Co-read 按钮 + Cinema 闲置 tick | `lastNudgeAt`（经 saveActivity）+ `active_message_plans` | PRESENT（委托 Active Message 调度） |
| DELETE | `IB.activity.deleteActivity()` | 删 `activities` 行（可选删 legacy thread、清指针） | **无生产调用者** |
| FINISH | — | — | **NOT PRESENT** |
| PAUSE | — | — | **NOT PRESENT**（活动级） |
| RESUME | — | — | **NOT PRESENT** |

**当前 canonical writer 是否唯一？** **是。** 穷举全仓 `dbPut('activities')` / `dbDelete('activities')`
只出现在 `activity-runtime.js`。Cinema / Co-read / communication / app-store 一律经 `IB.activity.*`。
**无多 writer 调用图**（因此不需要 §5 的"多 writer 图"）。

## 5 Lifecycle Reality

只按 repository reality，**不发明** P26-3 lifecycle：

```
create (createActivity)
   → open (App 打开资源；findActivity 复用 or createActivity)
   → current (setCurrent: 每角色一个指针)
   → progress (setProgress: 节流/翻页写回)
   → leave (clearCurrent：App unmount / 返回书架；**只清指针**)
   → delete (deleteActivity: 存在但**无生产调用者**)
   ✗ finish / pause / resume  —— NOT PRESENT
```

**`finished` 是只读识别，不是真实状态**：生产代码里 `status==='finished'` 只出现在**读侧**
（`_usableFor` / `setCurrent` 拒绝 / `resolveActivity` 过滤 / `send` 拒绝 / `nudge` 拒绝），
**没有任何写入者**（只有 smoke 测试手工写）。

**pause/resume 不属于 Activity lifecycle**：

| 概念 | 事实 |
| --- | --- |
| `cinema.pause` | **media transport**（`IBMedia` adapter 的 `adapter.pause()`），不是活动暂停 |
| `activity.pause` | **NOT PRESENT** |

二者**不得**混为一谈（本阶段明确冻结该区分）。

## 6 Current Pointer

`setCurrent` / `clearCurrent` / `resolveActivity` 的语义：

| 问题 | 回答 |
| --- | --- |
| pointer 是 session 吗？ | **不是** |
| 是 projection 吗？ | 部分是（指针是输入，`resolveActivity` 才是投影结果） |
| 是 navigation anchor 吗？ | **是**（App 打开/返回时设置/清除"当前活动"） |
| 是 runtime ownership 吗？ | 部分是（"谁在当前被打开"的事实所有权，但不裁决任何东西） |

**禁止把 pointer 升格成 Session**（本阶段明确）。关系：

```
Activity Record (canonical, 多条)
        │  被选择
        ▼
Current Pointer (localStorage, 每角色一个, 可重建)
        │  输入
        ▼
resolveActivity() → 本轮投影（每回合最多一个）
        ▲
UI Open State (App 容器显示哪个活动)      Media Runtime (adapter 实例，与记录无关)
```

## 7 Cinema Runtime

| 问题 | 回答（证据） |
| --- | --- |
| A. Cinema 是否拥有 Activity lifecycle？ | **否**。Cinema 只调用 `find/create/setCurrent/setProgress/clearCurrent/send`；没有 finish/pause 活动级命令。 |
| B. Cinema pause 是 media transport 还是 lifecycle？ | **media transport**（`IBMedia` adapter）。关闭/退出走 `unmount` → `clearCurrent`（**不是 finish**）。 |
| C. Cinema close 是否 finish Activity？ | **否**。`unmount` 只 `clearCurrent(_aiId,_activity.id)` + `_destroyCurrent()`（销毁 adapter）+ 清 `subs`；记录仍 `status:'active'`。 |
| D. frame 是否 persisted？ | **否**。`grabFrame()` → `snap.dataset.frame` → `IB.activity.send(...,{visionReference})` → 本轮 `sentImages`；不落库、不进 Memory、不写聊天记录。 |
| E. subtitle/progress canonical owner 是谁？ | **`IB.activity`**（写入 `activities.progress`：`sec/dur/subs/recap/noTime`）。Cinema 只是生产者。 |
| F. Cinema 是否存在资源竞争概念？ | **否**。`_loadMedia` 先 `_destroyCurrent()` 再建新 adapter（单实例串行）；无 owner/lease/lock/priority。 |

Cinema 完整链：`open/loadUrl` → `IBMedia.resolveMedia` → `createAdapter` → `findActivity`（同资源复用）
→ 否则 `createActivity` → `if(!threadId) setCurrent` → `adapter.load()` → `timeupdate`(1.5s 节流)
→ `setProgress` → `sendMsg` → `IB.activity.send(...,{visionReference?})` → 既有 chat/P23。

## 8 Co-read Runtime

完整链：`coreadOpen(postId)` → `_paginate` → `findActivity('coread',aiId,post.id)` →
否则 `createActivity({...,progress,bookmarks})` → `setCurrent` → `_renderReader`/`_renderNotes`
→ `_saveProgress`（`setProgress`）→ 翻页 / 书签（`saveActivity({bookmarks})`）→ `_coreadSend`
→ `IB.activity.send` → `coreadPaintshelf`（`clearCurrent(role,activity)`）。

| 数据 | 分类 |
| --- | --- |
| `activities.progress`（page/total/pct/chapter/pageText/recap） | **canonical state**（写在 `activities`） |
| `bookmarks` | **canonical state**（写在 `activities`） |
| reader 视图 / `_pi` / `_pages` | **UI state**（App 内存） |
| `getActivityContext` 注入的页文本切片 | **observation / projection**（只读、每回合派生） |
| current pointer | runtime 选择线索（非 session） |

## 9 Chat Boundary

`communication.js` 中的 Activity 相关面：

- `_ibTurnScope().activityId`：**回合级归属**（user message 记 `metadata.activityId`，assistant 同回合继承）；
- `resolveActivity(targetFriend,{activityId,threadId})`：每回合**解析一次**再注入 context；
- `getActivityContext(cfg.id,{activity,threadId,maxChars})`：注入 prompt（`P11-3X-C` 预算）；
- `_ibAppBroadcast('turn'|'message', {...activityId})`：UI/传输广播。

**Activity 是否拥有 Chat Message？→ NO（保持）。**
`chatMessages` 的 canonical authority **仍属 Chat**（只有 `communication.js` 写 `chatMessages`）；
Activity 只提供 **context/reference**：`send()` 把文本注入聊天输入框后调用 `sendChatMessage`，
**自身不写消息行**。

## 10 Event Candidate Matrix（P26-1）

**只设计候选点，不接线。** 铁律：`canonical writer succeeds → domain event`（禁止 event → writer）。

| 候选 | REAL FACT EXISTS? | CANONICAL WRITER EXISTS? | SAFE EMISSION POINT? | 判定 |
| --- | --- | --- | --- | --- |
| `activity.created` | **YES** | **YES**（`createActivity` 成功写入后） | **YES**（`dbPut` 成功后、返回前） | **READY** |
| `activity.progressed` | YES（progress 写回） | YES（`setProgress`） | YES | **NOT READY**（高频；见 §12 词汇表与 Q8） |
| `activity.finished` | **NO**（无 writer） | **NO** | NO | **NOT READY** |
| `activity.deleted` | YES（`deleteActivity` 成功删行） | YES | YES | **NOT READY**（**无生产调用者**；无消费者） |

## 11 Observation Candidate Matrix（P26-2）

**只设计候选，不接线，不塞正文/像素。**

| 候选 | producer | source | entityId | observedAt | freshness | availability | valueRef |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Cinema progress | Cinema App | `cinema.runtime` | `activityId` | 注入 | 读取时刻 | `sec/dur/noTime` | → `activities.progress`（**引用**，不复制） |
| Cinema subtitle | Cinema App | `cinema.runtime` | `activityId` | 注入 | 播放点 | `subs` 最近 N 可用性 | → **活动记录切片**（不得把字幕文本塞进 observation） |
| Cinema frame | Cinema App | `cinema.runtime` | `activityId` | 注入 | 本轮 | `caps.canFrame` | → **request-local visionReference 引用**（**禁止 base64 落库**） |
| Co-read page | Co-read App | `coread.runtime` | `activityId` | 注入 | 翻页时刻 | `page/total` | → `activities.progress` 引用 |
| Activity current state | `IB.activity` | `activity.runtime` | `roleId` / `activityId` | 注入 | 读取时刻 | pointer 有效/回退 | → `resolveActivity` 投影引用 |

**禁止**：把 subtitle text / frame base64 / **整个 Activity 对象**直接塞进 Observation；
需要内容时使用 **canonical/resource reference**。

## 12 Event Vocabulary Audit

不一次造很多 event type。分类：

| event type | 分类 | 理由 |
| --- | --- | --- |
| `activity.created` | **READY** | 真实事实 + 唯一 writer + 安全发点 + 低频率 |
| `activity.progressed` | **NOT READY** | 高频（Cinema 1.5s 节流仍是秒级）；应作为 **observation/pull**，不是 domain event |
| `activity.finished` | **NOT NEEDED（今天）** | lifecycle fact 不存在 → 不得发 event |
| `activity.deleted` | **NOT NEEDED（今天）** | 无调用者、无消费者 |

**progress 是否真的应该 emit Event？** **不应该。** 证据：进度语义是"现在是什么"（OBSERVATION），
不是"发生了什么"（EVENT）；且写回频率高，domain event 化会制造噪声与排序负担。

## 13 Observation Registration Shape

未来最小 production adapter 的**形状建议**（本阶段不实现）：

```
domain-owned getter（推荐）        例如 IB.activity.getObservation(activityId) → 纯读投影
或 registerObservationProvider(...)   仅当出现多个独立 consumer
```

**是否真的需要 central registry？** **不需要**（今天只有一个消费者：本轮 prompt 注入）。
⇒ **禁止**创建 `ObservationManager`（无多 consumer 证据）。

## 14 Session Mapping

| 关系 | Cinema | Co-read |
| --- | --- | --- |
| Activity Record : Session | **1:1（实践上）** | **1:1（实践上）** |
| 依据 | 同 角色+资源 复用同一条记录（`findActivity`）；current 指针只做选择 | 同一本书复用同一条记录 |

**Activity 创建是否等于 Session 创建？** **不默认相等。** 记录可长期存在并被反复"打开"，
而"打开/离开"不改变记录；真正的"活跃期间"是 pointer + App 内存，不是记录本身。

**Session identity 应如何映射？**

| 选项 | 判定 |
| --- | --- |
| A. reuse `activityId` | **推荐**（记录与"会话"在数据上 1:1；复用避免第二套 id） |
| B. derive from `activityId` | 次选（等价于 A 的变体） |
| C. independent `sessionId` | **证据不足**（今天没有"同一记录多个会话"的需求） |
| D. insufficient evidence | 对"独立 session 身份"成立 |

⇒ **identity：A（reuse activityId）；lifecycle：投影（见 §15），不建状态机。**

## 15 Session Migration Decision

**优先：NO MIGRATION。** 检查结论：**可以用 runtime projection / derived session 避免 DB_VER 25**。

理由（证据）：会话所需的全部字段**已经存在**于 `activities`——
`createdAt`（起点）、`lastActiveAt`（活跃度）、`status`（active/finished）、`progress`（位置）。
"活跃期间"可由 `(createdAt, lastActiveAt, pointer)` **纯派生**，无需新列/新 store。
⇒ **不 bump DB_VER、不新增 store、不新增 activity schema 字段**（见 §25）。

## 16 Participant Boundary

| 检查 | 事实 |
| --- | --- |
| Activity participant | **1:1 `roleId`**（`createActivity` 只接受一个 roleId） |
| user | 隐式（聊天侧持有，记录里没有 user 字段） |
| participants 数组 / join / leave | **NOT PRESENT** |
| multi-party Activity | **不存在入口** |

⇒ **保持 OUT OF SCOPE**；不因 P26-3 有 session participants 就做 multi-party Activity。

## 17 Resource Matrix（P26-4）

| 候选资源 | 分类 | 依据 |
| --- | --- | --- |
| Cinema playback surface | **REAL RESOURCE（virtual，单实例）** | 一个 App 实例一个 `#ci-player` + 一个 adapter；`_destroyCurrent()` 串行化 |
| audio output | **NOT RESOURCE** | 由 adapter/video 元素持有，无竞争面 |
| microphone | **NOT RESOURCE（对 Activity）** | 属 Call/Voice，与 Activity 零交叉 |
| camera / frame capture | **FUTURE RESOURCE（至多）** | `grabFrame` 是瞬时的 request-local 操作，不占用设备 |
| model execution | **FUTURE RESOURCE（且属 P25/model router）** | Activity 不直接调用模型 |
| network | **NOT RESOURCE** | 无带宽仲裁需求 |
| storage | **NOT RESOURCE** | IndexedDB 无配额仲裁需求 |

**不得**为了使用 P26-4 而强行制造 conflict。

## 18 First Real Conflict Candidate

**必须回答：P27 是否真的存在一个值得生产接入的 resource conflict？**

- 真实**记录**层面：同角色可同时存在多条 `status:'active'` 活动（smoke T6）——**但这不是资源冲突**，
  因为 current 指针负责选择，且记录并存是被允许的。
- 真实**资源**层面：唯一候选是 **Cinema playback surface**（单 adapter）。
  但同一 App 实例内 `_loadMedia` 已经 `_destroyCurrent()` **串行替换**，**不存在并发占用**。
- 跨 App / 跨角色：不同 App 实例各有自己的播放面，**无共享资源**。

**结论：今天不存在值得接入的真实 conflict。**
⇒ **P27-5（Resource Conflict Integration）应标 DEFER**，不得伪造测试场景。

## 19 Resource Identity Audit

若未来出现真实资源（如"全局唯一播放面"），**概念**上需要：`resourceId`（如 `playback.surface`）、
`capacity`（1）、`claim amount`（1）、`requesterId`。

**requester 应该是谁？** 证据倾向于 **`activityId`**（今天的活动是"使用播放面的主体"；
sessionId 尚未独立存在，runtimeId 过粗）。
**本阶段不实现。**

## 20 Existing Event Mechanisms

| 机制 | 分类 | 证据 |
| --- | --- | --- |
| `IB.activity.on/off/_emit` | **LOCAL_CALLBACK** | 同进程同页面，`_ev` 内存 map；`api.emit` 是**显式 no-op** |
| `IBApps.broadcast('turn'|'message')` | **UI / TRANSPORT EVENT** | 只投给**当前打开的 App**（`if(!_activeId) return`）；无持久化、无 ACK |
| DOM events（`online`/`visibilitychange`/pointer） | **UI EVENT** | 浏览器保证 |
| Active Message companion `events[]` | **PERSISTED_DOMAIN_EVENT（单域，既有）** | 与 Activity 零交叉 |

**不得**把 existing callback 自动升级为 P26 Domain Event（本阶段明确冻结）。

## 21 activity.mark Decision

重新审计真实代码：`mark()` 直接 `dbPut('chatMessages', {...,mark:{app:'activity',kind,phase,label}})`
——它写的是**聊天消息**（带 mark 元数据），不是活动状态；**生产无调用者**（只有导出）。

| 选项 | 判定 |
| --- | --- |
| A. migrate to P26 Domain Event | **暂不**（无 lifecycle fact、无消费者；且它写的是 chatMessages） |
| B. remain existing mechanism | **推荐（保持）** |
| C. delete later | 无证据（无调用者但也是公开 API） |
| D. insufficient evidence | 对 A/C 成立 |

**本阶段不改。**

## 22 Memory / Nudge Boundary

- **Memory**：`writeMemory` 只是**委托**（`quickCreateMemory`，`source=cinema|coread`，
  `visibility:'only'`，`visibleTo:[roleId]`）。**Memory subsystem ownership 不变**（Activity 不读 memories、不写 canonical 之外）。
- **nudge**：生成一条 **Active Message 计划**（`_activeSaveAiPlan`，8 分钟冷却 + 幂等）；
  **不是 Agent Wake**。**禁止**把 `nudge` 接到 P26-5..10。

## 23 P23 Boundary

`IB.activity.send` 最终仍进入**既有 chat / P23**（`sendChatMessage` → 交付队列）。
P27 **不拥有**：message splitting · sequence · delivery queue · typing · voice materialization。

## 24 P24 Boundary

Activity **不修改**：group participation · speaker selection · `groupOrder` · `groupTurnId` · INTERJECT。
Multi-party Activity = **OUT OF SCOPE**。

## 25 P25 Boundary

P27 **不实现** Activity Capability / Autonomy / Agent planning。
若未来 Activity 纳入 capability，**只记录 dependency**（现在不接）。

## 26 Proposed Production Ownership

| 组件 | OWNER | INPUT | OUTPUT | CANONICAL WRITE? | DEPENDENCIES | FAILURE SEMANTICS |
| --- | --- | --- | --- | --- | --- | --- |
| **Activity Lifecycle Writer** | `IB.activity`（**已存在**，不新造） | lifecycle command（若未来有 finish） | 更新后的 record | **YES（唯一）** | 无（保持既有） | 写失败 ⇒ 操作失败，**无事件** |
| **Activity Event Emitter** | `IB.activity`（post-write hook） | 成功后的事实 | P26-1 event 对象（不落库） | **NO** | P26-1 契约 | event 失败 ⇒ canonical 操作**仍成功**，不回滚 |
| **Activity Observation Adapter** | 域 getter（Cinema / Co-read / `IB.activity`） | 只读读取 | P26-2 observation（引用） | **NO** | P26-2 契约 | observation 失败 ⇒ canonical 不变 |
| **Activity Session Projection/Runtime** | `IB.activity`（纯投影） | `activities` 记录 + 指针 | 派生 session 视图 | **NO** | P26-3 契约 | 投影失败 ⇒ canonical Activity 不变 |
| **Activity Resource Adapter** | Cinema App（播放面守卫） | 资源请求 | 取得/未取得 | **NO**（今日无真实冲突） | P26-4 契约 | 冲突 ⇒ **不取得资源**；canonical 变更由所属操作决定（见 §27） |

## 27 Failure Semantics（冻结建议）

```
canonical writer fails  → operation fails → no event
canonical writer succeeds → operation success
event creation/emission fails → canonical operation remains success → no rollback
observation fails → canonical state unchanged
session projection fails → canonical Activity unchanged
resource conflict → no resource acquisition → canonical mutation policy TBD by owning operation
```

**铁律**：**secondary P26 mechanism 不得 rollback canonical domain fact。**

## 28 Schema / Migration

| 问题 | 结论 |
| --- | --- |
| DB_VER bump？ | **NO**（保持 24） |
| new store？ | **NO** |
| new activity schema fields？ | **NO**（projection/adapter 足够，见 §15） |

## 29 Event Bus Decision

继续保持 **EVENT BUS NOT REQUIRED**。本次 Activity production audit **未**发现：
multiple independent consumers · fanout · delivery guarantee · cross-runtime routing · replay。
⇒ **禁止 Event Bus。**

## 30 Tests / Guard Audit

P27 后续必须保护的测试（本阶段只读，不跑 full quick）：

| 套件 | 类型 |
| --- | --- |
| `tests/test_activity_smoke.js`（T1–T9 + legacy） | **浏览器**行为（Activity/Context/留影/legacy） |
| `tests/test_p25_3e_activity_boundary_audit.js` | 边界守卫（16） |
| `tests/test_domain_event_core.js` / `test_observation_core.js` / `test_session_core.js` / `test_resource_core.js` | P26-1..4 core |
| `tests/test_p26_closure_guard.js` | P26 冻结 |
| `tests/test_p27_0_activity_wiring_guard.js` | 本阶段证据守卫（10） |

## 31 P27 Stage Plan

| stage | 内容 | 判定 |
| --- | --- | --- |
| **P27-1** | Activity **Lifecycle Closure**（见 §32） | **REQUIRED（先做）** |
| **P27-2** | Domain Event Integration（**仅** `activity.created`） | READY（最小） |
| **P27-3** | Observation Integration（域 getter，引用而非复制） | READY |
| **P27-4** | Session Integration（**纯投影**，无 store/无迁移） | READY |
| **P27-5** | Resource Conflict Integration | **DEFER（无真实冲突）** |
| **P27-C** | Closure | 待前序 |

**不得为了编号完整而实现 P27-5。**

## 32 P27-1 Readiness

**下一阶段应该先做：Activity Lifecycle Closure，而不是"新 writer"。**

证据：当前**已经存在**足够的 canonical writer（`IB.activity` 是唯一写点），
缺的不是 writer，而是**生命周期语义的收口**——
`finished` 只读、`finish/pause/resume` NOT PRESENT、`deleteActivity` 无调用者、
`clearCurrent` 只清指针。因此 P27-1 的正确形态是：

1. **冻结 lifecycle 事实**（create → current → progress → leave → delete；finish/pause/resume 明确 NOT PRESENT）；
2. **决定**是否需要最小 `finish`（若需要，经**既有** `saveActivity` 路径，不新增 writer）；
3. 明确 `finished` 的**唯一**写入点与读侧行为。

**不要重复造 writer。**

---

## 附录 · Final Questions（Q1–Q17）

1. **Activity canonical state 的唯一 authority？** `IB.activity` 写入的 IndexedDB `activities` store。
2. **current pointer 是不是 Session？** **不是**（是 navigation anchor / 选择线索，可重建）。
3. **Activity 创建是否等于 Session 创建？** **不默认相等**（记录可反复打开；活跃期间是 pointer+内存）。
4. **finished 是否有真实 production writer？** **没有**（只读识别）。
5. **pause/resume 是否真实存在于 Activity lifecycle？** **不存在**。
6. **Cinema pause 是否只是 media transport？** **是**。
7. **哪些 Activity facts 现在已经适合 emit Domain Event？** 只有 `activity.created`。
8. **progress 是否真的应该 emit Event？** **不应该**（属 observation；高频）。
9. **哪些 observation 现在可以真实接入？** Cinema progress / subtitle（引用）/ frame（引用）/ Co-read page / Activity current state。
10. **Cinema frame 如何引用而不是复制？** 保持 request-local `visionReference`，observation 只带 `valueRef`/availability；**禁止 base64 落库**。
11. **Session identity 应如何映射？** **A：reuse `activityId`**（1:1），lifecycle 走投影。
12. **是否需要 DB migration？** **不需要**（projection 足够；DB_VER 保持 24）。
13. **是否存在真实 Resource conflict？** **不存在**（播放面已被单实例串行化）。
14. **activity.mark 应该怎么办？** **B：保持既有机制**（本阶段不改）。
15. **是否需要 Event Bus？** **不需要**。
16. **是否需要接 P26-5..10？** **不需要**（无 production consumer，P27 只验证 P26-1..4）。
17. **P27-1 应该具体做什么？** **Activity Lifecycle Closure**（冻结生命周期 + 决定最小 finish 是否经既有 writer），**不新造 writer**。
