# P25-3E · Activity Boundary Audit & Runtime Vocabulary Stress Test

状态：**AUDIT / CLASSIFICATION / STRESS TEST**（不是 implementation）。

**Production code changed = 0。** 本阶段没有新增 Activity Capability / Authority / Executor /
Session Manager / Queue / Event Bus / Observer Runtime，没有改 P23 / P24 / P25-3A Foundation /
Autonomy Core，没有 DB migration，没有注册任何 capability。

审计口径：**只以当前代码事实为准**；历史文档只作 intent evidence，不覆盖 runtime reality。

---

## 1. Scope 与结论摘要

本阶段用 Activity（Cinema / Co-read）压测 P25 的
`Candidate → Authority → Executor → Canonical Writer → Verify` 模型，
回答"什么装得下、什么装不下"。

**一句话结论**：

> Activity **不是**第五个 capability。它是一个**域运行时（Domain Runtime）**：
> 少量单写命令（create / progress / save / delete）**装得下**现有 P25 模型；
> 而 **session runtime state（current 指针 + 生命周期 + 参与者 + 资源归属）**、
> **只读观察（frame / progress / subtitle / presence / timeline）** 与
> **域事件（started / finished / joined / left / paused / progressed）** 在现有树里
> **没有家（NO_CURRENT_HOME）** —— 它们成为 P26 的需求输入，而不是本阶段的实现。

## 2. Repository Reality Audit（Phase 0，READ ONLY）

审计范围（穷举后只有这些真实文件与入口）：

| 对象 | 真实位置 |
| --- | --- |
| Activity 运行时 | `assets/js/activity/activity-runtime.js`（327 行，`IB.activity` / `window.IBActivity` / `window._activityCreate`） |
| Co-read 应用 | `assets/js/activity/coread.js`（167 行） |
| Cinema 应用 | `apps/ib-app-cinema.js`（187 行） |
| 媒体传输适配器 | `apps/ib-media-adapter.js`（`IBMedia.resolveMedia / createAdapter`：load / play / pause / seek / getCurrentTime / getDuration / destroy） |
| 聊天侧钩子 | `assets/js/communication.js`（`getActivityContext` 注入 + `metadata.activityId` 标记 + `_ibAppBroadcast`） |
| 存储 | IndexedDB `activities`（core.js，含 `byRole`/`byType` 索引）；localStorage `ib_activity_current_v1` |
| 既有测试 | `tests/test_activity_smoke.js`（T1–T9 + legacy） |
| **不存在** | `presence.*` / `timeline.*` / `vision.*` / `session.*` / `activity-authority` / activity queue / activity 服务端 |

### A. Activity canonical data structure

```js
{
  id: 'act_<now>_<rand>',
  type: 'cinema' | 'coread',          // 由 App 传入（createActivity 只校验 type/roleId/resourceId 非空）
  roleId: '<canonical role id>',      // 一对一角色（1:1 roleId）
  resourceId, resourceKey,            // 影片 / 书 的稳定键（findActivity 用它做"同资源复用"）
  title, kind, threadId: null,        // M1 起**不再**创建 chatThreads（legacy 数据才带 threadId）
  progress: { sec, dur, subs, recap, upTo, pct, noTime, page, total, pageText, chapter },
  bookmarks: [], recap: '', config: {},
  status: 'active' | 'finished',      // 只读判定；生产**没有任何**路径写入 'finished'（见 I/G/H）
  createdAt, updatedAt, lastActiveAt, lastNudgeAt
}
```

### B. Activity store

IndexedDB **`activities`**（`keyPath: id`）。活动是**上下文状态**，不是消息容器。
声明见 runtime 头注释 + `core.js` 的 store 列表（v21 引入）。

### C. 是否有 IndexedDB store

有：`activities`（唯一）。

### D. 是否有 localStorage pointer

有：`ib_activity_current_v1` —— **每角色一个** `{ activityId, at }`。
runtime 自述："指针是轻量、可重建的线索，**不是 authority**；丢失/失效时按
`status==='active'` + `lastActiveAt` 最新确定性回退"。

### E. 是否有 runtime-only state

有，且分两类：

1. **App 内 JS 状态**（runtime-only，不持久）：`apps/ib-app-cinema.js` 的 `_activity / _aiId / subs / sum / _lastCue / _typingTimer / _grabError`、media adapter 实例；`coread.js` 的 `_activity / _book / _pages / _pi / _bm`。
2. **活动记录内的可重建状态**：`progress` / `bookmarks` / `lastActiveAt` / `lastNudgeAt`（持久，但语义是"当前进度"，可被下一个 tick 覆写）。

### F. Activity lifecycle 当前有哪些真实状态

**只有两个读侧状态**：`status === 'active'`（默认）与 `status === 'finished'`（被 5 处读侧检查）。
`_usableFor` 的判据是"非 finished"。

**关键事实**：`'finished'` 在生产代码里**没有任何写入者** —— 只有 `tests/test_activity_smoke.js` 用
`IB.activity.saveActivity(id,{status:'finished'})` 手工写入（T8）。runtime 也没有 `finish()` / `end()` / `pause()`。
⇒ 生产现实的"会话结束"是**清空 current 指针（App 退出/返回）**，而不是写状态。

### G. createActivity 做什么

校验 `type/roleId/resourceId` → 生成 `act_<now>_<rand>` → 组装 record（`status:'active'`，`threadId:null`）
→ `dbPut('activities', rec)` → `_emit(rec.id,'activity',rec)`（**纯内存回调**）→ 返回 rec。
**不创建 chatThreads、不切换频道、不发消息、不写 Memory。**（storage 失败返回 `null`）

### H. finish/end Activity 做什么

**NOT PRESENT**（没有该函数）。与之最接近的既有动作是 `deleteActivity(id)`：
删 legacy thread（若有）→ 若指针指向它则 `clearCurrent(roleId)` → `dbDelete('activities',id)`。
它同样**没有生产调用者**（只有导出）。

### I. setCurrent / clearCurrent / resolveActivity 做什么

- `setCurrent(activityId)`：读记录 → 拒绝 `finished` → `_ptrSet(roleId, activityId)`（localStorage）→ `_emit(roleId,'current',{...})`。
- `clearCurrent(roleId, activityId?)`：可选第二参"只清自己"（App 退出用）→ `_ptrClear` → `_emit(... activityId:null)`。
- `resolveActivity(friendId, opts)`：确定性优先级 **0 显式 activityId → 1 legacy 频道锚（threadId 匹配）→ 2 有效 current 指针（非 legacy）→ 3 `status==='active'` 且非 legacy 中 `lastActiveAt` 最新者 → 4 null**；指针失效时顺手清理。

### J. 谁拥有 current activity

**域运行时**（`activity-runtime.js`）拥有指针；App 只调用。**Authority 一格都没有**（本阶段之前也不存在 Activity Authority）。

### K. current activity 是 canonical state / pointer / projection / cache？

**pointer + projection**：

- `activities` 里的 record 才是 canonical 数据；
- `ib_activity_current_v1` 是**每角色一个的指针**（可重建、可丢失、明确"不是 authority"）；
- `resolveActivity` 的结果是**派生的本回合投影**（每回合最多一个），`buildActivityContext` 再把投影渲染成 prompt 文本。

### L. Activity participant 当前如何表示

**单角色**：`roleId` 一个字段（1:1）。**没有 participants 数组、没有 join/leave、没有多角色会话、没有群活动**。
（Cinema 的"用户"由聊天侧隐式持有；活动记录里没有 user 字段。）

### M. join / leave / pause / resume / suspend / interrupt

全部 **NOT PRESENT**（作为 Activity 生命周期）：

| 概念 | 事实 |
| --- | --- |
| join / leave | 不存在（活动恒为 1 角色，创建即参与） |
| pause / resume（活动） | 不存在；`pause` 只作为**媒体传输控制**存在于 `IBMedia` adapter（`adapter.pause()`），是 UI/传输命令 |
| suspend | 不存在 |
| interrupt | 不存在（没有抢占、没有优先级、没有打断语义） |

### N. Cinema 如何创建 / 绑定 Activity

`open(input, aiId)` → `ensureMedia()`（动态加载 `apps/ib-media-adapter.js`）→ `IBMedia.resolveMedia/createAdapter`
→ `IB.activity.findActivity('cinema', aiId, key)`（**同资源复用**）→ 未命中则
`createActivity({type:'cinema', roleId, resourceId:key, resourceKey:key, title, kind:'cinema', quiet:true, memory:true, progress:{sec,dur,subs,recap,noTime}})
→ 若 `!threadId` 则 `setCurrent(activity.id)`；进度经 `_pushProgress`（**1.5s 节流**）写回；卸载时 `clearCurrent(aiId, id)`。

### O. Co-read 如何创建 / 绑定 Activity

`open(post)` → `findActivity('coread', aiId, post.id)` → 未命中则 `createActivity({type:'coread', ..., progress:{page,total,pct,pageText,chapter,recap}})`
→ `setCurrent`；翻页写 `setProgress`；书签写 `saveActivity({bookmarks})`；返回书架 `clearCurrent(roleId, id)`。

### P. Voice 是否真的属于 Activity？

**不属于**。`assets/js/communication/voice.js`（P23 Voice Runtime）与 Activity 之间没有任何引用：
Voice 是**交付通道**（P23 域），Activity 只通过 `IB.activity.send` 走聊天链路。
`proactive-interaction-core.js`（语音呼入交互事件）也独立于 Activity（它属于 Active Message 的 `voice_call` 计划）。

### Q. Cinema frame capture 当前属于什么

**request-local observation**：`grabFrame()` 产出 dataURL → 仅作为 `IB.activity.send(..., {visionReference:{dataUrl}})`
的**本轮请求参数**，随后进入既有 `sentImages → provider vision` 链路；runtime 注释明确"**不捕获、不存储、不转发**任何像素数据"，
smoke 断言 `Vision.frameNotPersisted`。⇒ 既不是 state，也不是 message attachment（`chatMessages` 里没有 `images`）。

### R. subtitle / progress 属于什么

**持久化的活动状态**（`activities.progress`）：Cinema 存 `{sec,dur,subs:[最近 N 条],recap,upTo,pct,noTime}`，
Co-read 存 `{page,total,pct,pageText,chapter,recap}`。字幕来自**用户本地加载的 `.srt`**（`parseSubs`），
不来自网络；它是"到播放点为止"的切片，供 `buildActivityContext` 注入 prompt。

### S. Presence 当前是什么

**NOT PRESENT（Activity 域）**。全仓 `presence` 只出现在：Home Node / Mobile Gateway 的
`presence.report` / `presence.changed`（移动端在线状态，与 Activity 无关）、launcher 的启动进程探测、tarot 卡牌名。

### T. Timeline 当前是什么

**NOT PRESENT（Activity 域）**。唯一 "timeline" 是 `game/game_tarot.js` 的卡牌名与文档修辞。

### U. Activity broadcast 当前是什么机制

两层，都不是 Activity 域：

1. **runtime 内存回调**：`IB.activity.on/off`（`_ev` map + `_emit`）——同进程、同页面、无持久化；`api.emit` 是**显式 no-op**（占位）。
2. **应用广播**：`communication.js` 的 `_ibAppBroadcast('turn'|'message', {...activityId})` → `IBApps.broadcast`，
   由 Cinema 订阅（按 `activityId` 过滤小窗消息、点亮/熄灭 typing）。这是**UI/传输事件**。

### V. 是否已经存在 event-like mechanism

有，但都是"事件**式**"而非域事件总线：内存回调（上）、`IBApps.broadcast`（UI/传输）、
`window` 事件（`addEventListener('online'|'visibilitychange')`）、Active Message 的**持久化事件队列**
（`active_message_history`/events，属另一个域）、`proactive-interaction-core` 的 localStorage 交互事件。

### W. 是否已有 started / finished / joined / left / paused / resumed / progress / frame 事件

| 候选事件 | 现状 |
| --- | --- |
| started / finished / joined / left / paused / resumed | **NOT PRESENT**（没有事件、没有状态写入者） |
| progress | **不是事件，是状态字段**（`progress` 覆盖写） |
| frame | **不是事件，是本轮请求参数**（`visionReference`） |
| `mark(activityId, phase, label)` | 存在的**标记消息**写入器：`dbPut('chatMessages', {mark:{app:'activity',kind,phase,label}})` —— 但**生产无调用者**（只有导出） |

### X. Activity 是否直接写 chatMessages

**是（两处，且都在域外语义上）**：

1. `mark()`：**直接** `dbPut('chatMessages', ...)`（标记消息；当前无生产调用者）；
2. `send()`：**间接**经 `sendChatMessage`（聊天链路负责落库；活动只携带 `activityId` / `visionReference`）。
聊天侧再据此给 user/assistant 打 `metadata.activityId`（回合身份，与 P23 的 `turnId/sequence` 正交）。

### Y. Activity 是否影响 P23 Delivery

**不影响**。P23 五个核（delivery-planner / delivery-runtime / delivery-sequence-core /
multimodal-delivery-policy / voice-message-core）里只有 `delivery-sequence-core.js` 的**注释**提到
`metadata.activityId` 是与 turn 身份同位置的概念；零代码依赖。
Activity 唯一进入模型侧的方式是**上下文预算**（`_IB_BUDGET_CAP_TOKENS.activity=2600`）。

### Z. Activity 是否影响 P24 Group Runtime

**不影响**。`group-runtime-core.js` 零 `activity` 引用；群聊与 Activity 没有交叉。

### AA. Activity 是否读取 / 写入 Memory

- **读**：无（Activity runtime 不读 `memories`；聊天注入的记忆由 Memory 域负责）。
- **写**：有，唯一入口 `IB.activity.writeMemory(activity,title,content)` → `quickCreateMemory`
  （`source = 'cinema'|'coread'`，`visibility:'only'`，`visibleTo:[roleId]`）。
  触发者**只有用户点击**（Cinema `#ci-mem` / Co-read `#mem` 按钮），**没有自动写入**。
  ⇒ 它是"委托给 Memory 域的写"，不属于 Activity canonical write。

### AB. Activity 是否读取 / 写入 Middle Brain

**零**。三个活动文件里没有任何 MB 符号（`_mbSideEffectGate` / `_execMemOps` / middleBrain / `_MB_SEC`）。

### AC. Activity 是否有 resource ownership

**没有所有权概念**。只有"同资源复用"（`findActivity(type, roleId, resourceId)`）与"每角色一个指针"。
没有锁、没有租约、没有排他、没有冲突检测、没有 release。

### AD. Cinema / Co-read 是否存在 one active session / exclusive ownership / concurrent session / resource conflict

| 概念 | 现状 |
| --- | --- |
| one active session | **不是强约束**：同一角色可同时存在多个 `status:'active'` 活动（smoke T6 就创建了两个） |
| exclusive ownership | **NOT PRESENT** |
| concurrent session | **存在且被允许**（活动记录并存；指针只选一个） |
| resource conflict | **NOT PRESENT**（同资源再次打开会复用记录；不同资源不做仲裁） |

### AE. Activity 是否存在 scheduler / queue

**没有自己的 scheduler / queue**。三处"时间"：
1. `_activeTick`（30s）里**没有** activity tick（活动不被后台 tick 驱动，只有 App 打开时才有 UI 行为）；
2. Cinema 本地 `tick()`（UI 定时器）：闲置 120s 且距上次 nudge ≥8min → `IB.activity.nudge`；
3. `nudge()` 的延迟执行交给 **Active Message 的计划**（`_activeSaveAiPlan`，由 Active Message 的调度承担）。

### AF. 当前 cancellation / interruption 如何工作

**没有取消/打断机制**。现有近似语义只有：
`send()` 对 `status==='finished'` 的活动直接返回 `{ok:false,error:'activity_finished'}`（**显式拒绝，不 fallback**，但生产没有写入 finished 的路径）；
`clearCurrent(roleId, activityId)` 只清指针（App 退出/返回）；
`deleteActivity()` 删记录（无生产调用者）。**没有** pause/interrupt/abort/preempt。

## 3. Activity Primitive Inventory（真实存在的原语）

清单只登记**代码里能指认实现**的原语；不存在的写 `NOT PRESENT`。

| 层 | 原语（真实 API / 行为） |
| --- | --- |
| Activity runtime 写 | `createActivity` · `saveActivity` · `setProgress` · `deleteActivity` |
| Activity runtime 读 | `getActivity` · `findActivity` · `listActivities` · `buildActivityContext` · `getActivityContext` |
| Activity 指针 | `setCurrent` · `clearCurrent` · `resolveActivity` |
| Activity 旁路 | `send`（→ 聊天链路 + `visionReference`）· `openChat`（UI）· `mark`（直接写 chatMessages，无生产调用者）· `writeMemory`（→ Memory 域）· `nudge`（→ Active Message 计划）· `fav`（→ 收藏域） |
| Activity 事件 | `on` / `off`（内存回调）· `emit`（**显式 no-op**） |
| Cinema（App） | `open`（find/create/current）· `play` / `pause` / `seek`（媒体传输）· `progress`（1.5s 节流写回）· `subtitle`（本地 `.srt` 解析 + 最近 N 条切片）· `frame`（request-local `visionReference`）· `nudge`（手动 + 闲置 tick） |
| Co-read（App） | `open` · `page`（翻页写回）· `bookmark`（写回）· `nudge` · `writeMemory` |
| **NOT PRESENT** | `finish` · `end` · `pause`（活动级）· `resume` · `join` · `leave` · `suspend` · `interrupt` · `presence.observe` · `timeline.observe` · 会话所有权仲裁 · started / finished / joined / left / paused / progressed 域事件 |

## 4. Classification Table（§33）

分类闭集：`SINGLE_EFFECT_COMMAND` / `LIFECYCLE_COMMAND` / `STATEFUL_RUNTIME` /
`READ_ONLY_OBSERVATION` / `RESOURCE_OPERATION` / `DOMAIN_EVENT` / `UI_EFFECT` / `UNKNOWN`。
`Capability/Authority/Executor/Writer/Verify/Observation/Runtime/Event` 列表示"能否放进现有树的那一层"
（YES / NO / PARTIAL）。

| Primitive | Exists | Class | Capability | Authority | Executor | Writer | Verify | Observation | Runtime | Event | Placement |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| activity.create | YES | SINGLE_EFFECT_COMMAND | YES | PARTIAL | YES | YES | YES | NO | YES | NO | FITS_CAPABILITY |
| activity.read.getActivity | YES | READ_ONLY_OBSERVATION | NO | NO | NO | NO | NO | PARTIAL | YES | NO | FITS_DOMAIN_RUNTIME |
| activity.read.findActivity | YES | READ_ONLY_OBSERVATION | NO | NO | NO | NO | NO | PARTIAL | YES | NO | FITS_DOMAIN_RUNTIME |
| activity.read.listActivities | YES | READ_ONLY_OBSERVATION | NO | NO | NO | NO | NO | PARTIAL | YES | NO | FITS_DOMAIN_RUNTIME |
| activity.save | YES | SINGLE_EFFECT_COMMAND | YES | PARTIAL | YES | YES | YES | NO | YES | NO | FITS_CAPABILITY |
| activity.progress | YES | SINGLE_EFFECT_COMMAND | YES | PARTIAL | YES | YES | YES | NO | YES | NO | FITS_CAPABILITY |
| activity.delete | YES | SINGLE_EFFECT_COMMAND | YES | PARTIAL | YES | YES | YES | NO | YES | NO | FITS_CAPABILITY |
| activity.current.set | YES | STATEFUL_RUNTIME | NO | NO | PARTIAL | PARTIAL | NO | NO | YES | NO | FITS_DOMAIN_RUNTIME |
| activity.current.clear | YES | STATEFUL_RUNTIME | NO | NO | PARTIAL | PARTIAL | NO | NO | YES | NO | FITS_DOMAIN_RUNTIME |
| activity.current.resolve | YES | STATEFUL_RUNTIME | NO | NO | NO | NO | NO | PARTIAL | YES | NO | FITS_DOMAIN_RUNTIME |
| activity.context.build | YES | READ_ONLY_OBSERVATION | NO | NO | NO | NO | NO | PARTIAL | YES | NO | FITS_DOMAIN_RUNTIME |
| activity.send | YES | SINGLE_EFFECT_COMMAND | PARTIAL | NO | NO | NO | NO | NO | YES | NO | FITS_DOMAIN_RUNTIME |
| activity.openChat | YES | UI_EFFECT | NO | NO | NO | NO | NO | NO | NO | NO | FITS_UI_EFFECT |
| activity.memory.write | YES | SINGLE_EFFECT_COMMAND | NO | NO | NO | NO | NO | NO | YES | NO | FITS_DOMAIN_RUNTIME |
| activity.nudge | YES | SINGLE_EFFECT_COMMAND | NO | NO | NO | NO | NO | NO | YES | NO | FITS_DOMAIN_RUNTIME |
| activity.mark | YES | DOMAIN_EVENT | NO | NO | NO | NO | NO | NO | NO | PARTIAL | NO_CURRENT_HOME |
| activity.fav | YES | UI_EFFECT | NO | NO | NO | NO | NO | NO | NO | NO | FITS_UI_EFFECT |
| activity.event.subscribe | YES | UI_EFFECT | NO | NO | NO | NO | NO | NO | PARTIAL | YES | FITS_EXISTING_EVENT |
| activity.finish | NO | LIFECYCLE_COMMAND | NO | NO | NO | NO | NO | NO | NO | NO | NOT_PRESENT |
| activity.pause | NO | LIFECYCLE_COMMAND | NO | NO | NO | NO | NO | NO | NO | NO | NOT_PRESENT |
| activity.resume | NO | LIFECYCLE_COMMAND | NO | NO | NO | NO | NO | NO | NO | NO | NOT_PRESENT |
| activity.join | NO | LIFECYCLE_COMMAND | NO | NO | NO | NO | NO | NO | NO | NO | NOT_PRESENT |
| activity.leave | NO | LIFECYCLE_COMMAND | NO | NO | NO | NO | NO | NO | NO | NO | NOT_PRESENT |
| activity.suspend | NO | LIFECYCLE_COMMAND | NO | NO | NO | NO | NO | NO | NO | NO | NOT_PRESENT |
| activity.interrupt | NO | LIFECYCLE_COMMAND | NO | NO | NO | NO | NO | NO | NO | NO | NOT_PRESENT |
| cinema.open | YES | SINGLE_EFFECT_COMMAND | NO | NO | PARTIAL | NO | NO | NO | YES | NO | FITS_DOMAIN_RUNTIME |
| cinema.play | YES | UI_EFFECT | NO | NO | NO | NO | NO | NO | NO | NO | FITS_UI_EFFECT |
| cinema.pause | YES | UI_EFFECT | NO | NO | NO | NO | NO | NO | NO | NO | FITS_UI_EFFECT |
| cinema.seek | YES | UI_EFFECT | NO | NO | NO | NO | NO | NO | NO | NO | FITS_UI_EFFECT |
| cinema.progress | YES | READ_ONLY_OBSERVATION | NO | NO | NO | PARTIAL | NO | PARTIAL | YES | NO | FITS_DOMAIN_RUNTIME |
| cinema.subtitle | YES | READ_ONLY_OBSERVATION | NO | NO | NO | PARTIAL | NO | PARTIAL | YES | NO | FITS_DOMAIN_RUNTIME |
| cinema.frame | YES | READ_ONLY_OBSERVATION | NO | NO | NO | NO | NO | PARTIAL | PARTIAL | NO | FITS_OBSERVATION |
| cinema.nudge | YES | SINGLE_EFFECT_COMMAND | NO | NO | NO | NO | NO | NO | YES | NO | FITS_DOMAIN_RUNTIME |
| coread.open | YES | SINGLE_EFFECT_COMMAND | NO | NO | PARTIAL | NO | NO | NO | YES | NO | FITS_DOMAIN_RUNTIME |
| coread.page | YES | SINGLE_EFFECT_COMMAND | YES | PARTIAL | YES | YES | YES | NO | YES | NO | FITS_CAPABILITY |
| coread.bookmark | YES | SINGLE_EFFECT_COMMAND | YES | PARTIAL | YES | YES | YES | NO | YES | NO | FITS_CAPABILITY |
| coread.nudge | YES | SINGLE_EFFECT_COMMAND | NO | NO | NO | NO | NO | NO | YES | NO | FITS_DOMAIN_RUNTIME |
| presence.observe | NO | READ_ONLY_OBSERVATION | NO | NO | NO | NO | NO | NO | NO | NO | NOT_PRESENT |
| timeline.observe | NO | READ_ONLY_OBSERVATION | NO | NO | NO | NO | NO | NO | NO | NO | NOT_PRESENT |
| activity.session.ownership | NO | RESOURCE_OPERATION | NO | NO | NO | NO | NO | NO | PARTIAL | NO | NO_CURRENT_HOME |
| activity.event.started | NO | DOMAIN_EVENT | NO | NO | NO | NO | NO | NO | NO | PARTIAL | NO_CURRENT_HOME |
| activity.event.finished | NO | DOMAIN_EVENT | NO | NO | NO | NO | NO | NO | NO | PARTIAL | NO_CURRENT_HOME |
| activity.event.joined | NO | DOMAIN_EVENT | NO | NO | NO | NO | NO | NO | NO | PARTIAL | NO_CURRENT_HOME |
| activity.event.left | NO | DOMAIN_EVENT | NO | NO | NO | NO | NO | NO | NO | PARTIAL | NO_CURRENT_HOME |
| activity.event.paused | NO | DOMAIN_EVENT | NO | NO | NO | NO | NO | NO | NO | PARTIAL | NO_CURRENT_HOME |
| activity.event.progressed | NO | DOMAIN_EVENT | NO | NO | NO | NO | NO | NO | NO | PARTIAL | NO_CURRENT_HOME |

（`cinema.pause` 是**媒体传输**暂停（`IBMedia` adapter），`activity.pause` 才是活动生命周期暂停 ——
前者 PRESENT，后者 NOT PRESENT。二者不能混为一谈。）
