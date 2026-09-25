# P27-3 · Activity Observation Integration

阶段性质：**PRODUCTION INTEGRATION / MINIMAL OBSERVATION WIRING / DOMAIN-OWNED GETTERS /
NO OBSERVATION MANAGER / NO REGISTRY / NO MIGRATION / NO EVENT BUS / NO COMMIT**。

上游冻结（保持）：P27-0（Activity 生产审计）· P27-1（finish/pause/resume NOT PRESENT）·
P27-2（**唯一** Domain Event = `activity.created`）。

---

## 1 State

**P27-3 State: PASS（WITH NOTES）**

- 集成**恰好一种**观察：**`IB.activity.getObservation(activityId)`** —— 对 canonical Activity
  状态的**只读**观察（`domain='activity'`, `source='activity.state'`, `entityId=activityId`,
  `valueRef='activities/<activityId>'`）。
- 观察 = READ ONLY / NON-CANONICAL / NON-EVENT / NON-ACTION / NON-WAKE。
- **无** ObservationManager / Registry / Service / Store；**无** consumer；**无** DB 变更。
- Notes：本阶段再次改动 `activity-runtime.js` 与 `InternalBeyond.html` ⇒ 触发**第二轮**
  冻结哈希耦合（见 §25，记 **HASH_COUPLING_DEBT**）。

## 2 Candidate Re-validation

对当前生产代码重新分类（不因 P27-0 曾列出就一律集成）：

| 候选 | 分类 | 依据 |
| --- | --- | --- |
| **A. Activity canonical state** | **READY → 已集成** | 稳定 producer（`IB.activity`）· 稳定 entityId（activityId）· 廉价读（`getActivity`）· 无新持久化 · 无 lifecycle · 无正文复制 |
| B. Activity current pointer | **DEFER** | 语义是"每角色的指针"，且唯一现有读路径 `resolveActivity` **自带 stale-pointer 清理副作用**；P26-2 观察要求纯读。需要先决定"current 是 pointer 还是 resolve 结果"，属 P27-4 投影议题 |
| C. Co-read page | **DEFER（已被 A 覆盖）** | page 属 `activities.progress`（canonical）；已由 A 的 `valueRef` 指向的同一位置承载，无需第二个观察种类 |
| D. Cinema progress | **DEFER（已被 A 覆盖 + 语义区分）** | canonical 节流进度 = A 的同一位置；**live player time** 属 `IBMedia` runtime（见 §14），不是 canonical 观察 |
| E. Cinema subtitle | **DEFER** | 当前字幕只在 App runtime（`subs` 数组，载入 `.srt` 后内存持有）；canonical 侧只有 `progress.subs` 切片，**没有稳定 valueRef**；集成会退化为内容搬运（§10 明令禁止） |
| F. Cinema frame | **DEFER** | request-local `visionReference`，**不持久**；集成需要新的存储（§11 明令禁止） |

## 3 Integrated Observation Set

**恰好一个**：`activity.state`（按 `activityId` 观察 canonical Activity 状态）。

```
IB.activity.getObservation(activityId, { observedAt? }) -> observation | null
   domain      : 'activity'
   entityId    : <activityId>
   source      : 'activity.state'
   observedAt  : 注入优先，否则读取时刻（_now；既有 producer 语义）
   freshness   : 'fresh'（producer 在读取时刻声明）
   availability: 'available' | 'unavailable'（记录是否存在）
   valueRef    : 'activities/<activityId>'   ← 引用 canonical 位置，不复制状态
```

## 4 Why This Is Minimal

按 §4 的择优标准逐条核对：稳定 producer ✓（`IB.activity`）· 稳定 entityId ✓（activityId）·
廉价读 ✓（一次 `getActivity`）· 无新持久化 ✓ · 无新 lifecycle ✓ · 无大对象复制 ✓ ·
无 media 归属歧义 ✓ · 无新 manager ✓。

候选 B–F 要么被 A 的 `valueRef` **同一位置**覆盖（page / progress），要么需要**新存储**
（frame）或**内容搬运**（subtitle），要么**读路径自带副作用**（current pointer）。
⇒ 一种观察即可证明 P26-2 在生产可用，故**只集成一种**（§4 明确允许"one is acceptable"）。

## 5 P26-2 Core Usage

审计后**只调用** `window.IBObservationCore.createObservation(input, options)`；
源码中**没有**自定义校验、**没有**复制 freshness / availability 词表。

| 项 | 值（来自 `assets/js/observation-core.js`） |
| --- | --- |
| API | `createObservation` · `validateObservation` · `normalizeObservation` · `freshnessOf` · `describeObservation` |
| REQUIRED | `observationId`（可派生）· `domain` · `entityId` · `source` · `observedAt` · `freshness` · `availability` |
| OPTIONAL | `valueRef`（**引用**串，`REF_PATTERN`，≤200） |
| freshness 闭集 | `fresh` / `stale` / `unknown` |
| availability 闭集 | `available` / `unavailable` / `unknown` |
| 正文拒绝 | `RESERVED_VALUE_FIELDS` + `RESERVED_VALUE_PATTERN`（value/snapshot/payload/base64/frame…） |

## 6 Production API

```
IB.activity.getObservation(activityId, opts) -> observation | null
```

- **读**操作；不返回 Promise 之外的副作用；失败一律返回 `null`（**绝不抛错**）。
- **无** manager / registry / routing / persistence。
- 领域自有 getter（不是全局观察服务）；只有一个入口（守卫 O9 断言源码里
  `IBObservationCore` 只出现一次、`getObservation(activityId,opts)` 只有一个定义）。
- 命名说明：函数名用 `getObservation` 而非 `observe`，以免与 P25-3E 审计中
  **NOT PRESENT** 的 `presence.observe` / `timeline.observe` 发生**名字假碰撞**
  （该守卫按"裸名 + `(` / `:`"判定入口是否存在）。

## 7 Ownership

| 关注点 | 所有者 |
| --- | --- |
| 状态本体 | `IB.activity`（canonical，未变） |
| 观察 producer | **`IB.activity`**（领域自有 getter） |
| 观察契约 | P26-2 `observation-core.js`（唯一） |
| 观察消费 | **无**（今天没有 consumer） |

## 8 valueRef Semantics

`valueRef = 'activities/<activityId>'` —— **canonical 存储位置引用**（store 名 + key），
不含值本身。`progress` / `page` / `subtitle 切片` / `bookmarks` 都是该位置的**子字段**，
消费者按需在该位置读取（`IB.activity.getActivity(activityId)`）。
**没有**通用任意对象逃生舱：`valueRef` 必须是单个引用串（P26-2 `REF_PATTERN`）。

## 9 Freshness

producer 在**读取时刻**声明 `freshness:'fresh'`（我们刚刚读了 canonical 记录）。
**不引入** polling / TTL / refresh scheduler；消费者若需判断过期，用 P26-2 的纯函数
`freshnessOf(observation, { now, maxAgeMs })` 自行派生（Core 不读时钟）。

## 10 Availability

`available`（记录存在）/ `unavailable`（记录不存在）。
**不可用不是业务失败**：返回的仍是**合法观察**；不抛错、不造 fallback 内容、
不唤醒 agent、不触发模型、**不修改 Activity**（守卫 O6）。

## 11 Activity Current

审计结论（**DEFER，本轮不集成**）：

| 问题 | 回答 |
| --- | --- |
| "current" 是什么？ | 每角色一个 `{activityId, at}` 指针（`ib_activity_current_v1`） |
| current for which role？ | 指针**按角色**（`roleId`）存放；`entityId` 只能是 roleId（不是 activityId） |
| canonical 还是 pointer-derived？ | **pointer-derived**（自述"不是 authority"） |
| stale pointer？ | `resolveActivity` 会**顺手清理**（写 localStorage）；纯读观察不允许新增此类副作用 |
| 无 current？ | `resolveActivity` 走确定性回退（最近 `lastActiveAt` 的 active 记录） |

⇒ "current" 有两个不同语义（**指针事实** vs **解析结果**），且现有读路径带**写副作用**；
需要先做投影决策（P27-4），故 **DEFER**，不做半语义集成。

## 12 Activity Progress

`progress`（含 Co-read 的 `page`/`pageText`/`recap`、Cinema 的 `sec`/`subs`）住在
`activities.progress`（**canonical**）。它不是独立观察对象，而是 §3 的 `valueRef`
（`activities/<id>`）指向的**子状态** ⇒ 无需第二个观察种类，也**不复制**正文。
`activity.progressed` 仍**不是** Domain Event（P27-0/P27-2 冻结）。

## 13 Co-read Page

审计：当前页 = `_pi+1`（App UI/runtime state）→ 写回 `activities.progress.page`
（canonical）。观察只需引用 `activities/<activityId>`；**不嵌入**整页文本、书内容或梗概 dump。
⇒ 已由 §3 覆盖，**不单列**。

## 14 Cinema Progress

审计**归属**：

| 事实 | 归属 | 是否 canonical |
| --- | --- | --- |
| `IB.activity.progress`（`sec/dur/subs/recap`，1.5s 节流写回） | `activities` store | **canonical** |
| 播放器**实时** `currentTime` | `IBMedia` adapter / `_adapter` | runtime（**不持久**） |

**区别已明确记录**：观察引用的是 **canonical 节流进度**；
实时播放位置是 media runtime 事实，**不是**同一观察（不得静默混为一谈）。

## 15 Cinema Subtitle

审计：当前字幕（`cueAt` 结果）来自 App 内存 `subs`（用户本地载入 `.srt` 解析）；
canonical 侧只有 `progress.subs`（最近 N 条的切片）。
**没有稳定 valueRef**（既非记录字段级引用，也非 resource id）⇒ 任何集成都会把
**字幕文本**搬进观察，违反 P26-2（Observation 描述/引用状态，**不是内容传输**）。
⇒ **DEFER**。

## 16 Cinema Frame

审计：frame 是 **request-local** `visionReference`（`send` 的本轮参数），
**不持久、不落库、不进 Memory、不写聊天记录**。
未创建 frame store / blob store / base64 观察 / media cache / 新 resource id。
结论：**DEFER**（若集成需要新持久化 ⇒ 按 §11 必须 DEFER）。

## 17 Read-only Proof

守卫 **O5**：`getObservation` 前后 canonical 写入计数差 = **0**（零 `dbPut` / 零 localStorage /
零回调副作用）。**O6**：不可用来源同样 0 写入。**O13**：核心缺失时返回 `null`，0 写入。
⇒ 观察创建本身**不写** `activities` / `chatMessages` / `memories` / `active_message_plans` /
localStorage。

## 18 Event Boundary

**Observation ≠ Domain Event。** 本阶段**未新增任何事件类型**（无 `activity.observed` /
`activity.progressed` / `cinema.frame_observed` / `coread.page_changed`）。
守卫 **O7**：`getObservation` 期间 Domain Event 创建调用数 = **0**。
P27-2 的 `activity.created` 仍是**唯一**生产 P26 Domain Event（守卫 **O12** 回归证明）。

## 19 Feedback/Wake Boundary

未引用 `feedback-core` / `feedback-consumption-core` / `wake-request-core` /
`wake-runtime-core` / `activation-intent-core` / `activation-runtime-core`（守卫 O8）。
`Observation Available != Feedback`；`Observation Available != Wake`。

## 20 Session/Resource Boundary

- **未集成 P26-3**：无 `sessionId` 字段、无 session store、无 start/end（守卫 O8/O10）。
  `entityId` 仍是 `activityId`（不是 session 身份）。P27-4 owns session projection。
- **未集成 P26-4**：frame/media 观察**不** claim / grant / lock 任何资源；P27-5 仍 DEFER。
- **Chat 边界**：观察**不**拥有/快照聊天；无 chat history / recent messages / dump
  （守卫 O4）。`communication.js` **未改**。

## 21 Failure Semantics

```
underlying read 失败        -> observation unavailable/null -> canonical 不变
observation 创建被契约拒绝   -> 返回 null                    -> canonical 不变
observation core 缺失       -> 返回 null                    -> canonical 不变（O13）
consumer 不存在             -> 无影响
```

**永不**：observation 失败 → 回滚 Activity。实现整体 `try/catch`，绝不抛错。

## 22 HTML/Core Loading

新增一行（紧随 `domain-event-core.js`，因为两者都依赖已加载的
`chat-core.js`（`stableToken`）与 `voice-message-core.js`（秘密探针））：

```
<script src="assets/js/domain-event-core.js"></script>   <!-- P27-2 -->
<script src="assets/js/observation-core.js"></script>    <!-- P27-3 -->
```

**生产加载的 P26 core 现在恰好 2 个**：`domain-event-core` · `observation-core`。
`session` / `resource` / `feedback` / `wake` / `activation` 核心**均未加载**（守卫 O11）。
`activity-runtime` 对核心是**惰性解析**，故 script 顺序不影响正确性。

## 23 Tests

新增 `tests/test_p27_3_activity_observation_guard.js`（**13 checks**，vm + 桩真实执行）：

| check | 内容 |
| --- | --- |
| O1 | 集成观察通过 P26-2 校验（domain/source/freshness/availability/observedAt/id） |
| O2 | `entityId` 指向正确 Activity |
| O3 | 不复制完整 Activity 对象（字段 ⊆ `ALLOWED_FIELDS`；远小于记录） |
| O4 | 无 subtitle / frame / page / chat 正文泄漏 |
| O5 | **观察读取 0 写入** |
| O6 | 不可用来源不改变状态；非法 id 返回 `null` |
| O7 | 观察**不发** Domain Event |
| O8 | 无 Feedback / Wake / Agent 行为 |
| O9 | 无 manager / registry / store / queue / scheduler；只有一个入口 |
| O10 | `DB_VER` 仍 24、无 observation store |
| O11 | 只加载预期的两个 P26 core |
| O12 | P27-2 `activity.created` 行为保持 |
| O13 | 核心缺失安全（`null` + 0 写入） |

## 24 Regression

| 套件 | 结果 |
| --- | --- |
| P27-3 guard（新增） | 13 PASS |
| P27-2 / P27-1 / P27-0 | 7 / 11 / 10 PASS |
| P26-1 / P26-2 | 42 / 32 PASS |
| P26-3 / P26-4 / P26-5 | 24 / 22 / 19 PASS |
| P26-0 requirements / P26 closure | 17 / 8 PASS |
| P25-3E activity boundary | 16 PASS |
| P25-3A registry / orchestration · Autonomy | 13 / 28 / 41 PASS |

未跑 full quick（无 schema / 全局权威变更）；未跑浏览器 smoke（生产 Activity 代码**变了**，
但改动是**新增只读函数**，未改既有调用路径 —— 见 §29 Limitations）。

## 25 Frozen Guard Re-baseline

按 §28 分类每一处基线更新：

| 文件 | 类别 | 说明 |
| --- | --- | --- |
| `test_domain_event_core.js`（G6 哈希） | **B** | `activity-runtime.js` 整文件哈希变了，但被守护的不变量（**唯一 emitter = activity-runtime**）未变 |
| `test_p25_3e_activity_boundary_audit.js`（A14 哈希） | **B** | 同上；A1b 未受影响（函数名改为 `getObservation` 以避免与 NOT_PRESENT 裸名假碰撞 —— **无需**修改该审计断言） |
| `test_p26_0_runtime_requirements.js`（R1/R15 哈希） | **B** | 同上 |
| `test_session_core.js` / `test_resource_core.js` / `test_feedback_core.js`（G8 哈希） | **B** | 同上 |
| `test_observation_core.js`（G1.g7 **语义** + G8 哈希） | **A** | "production observers = 0" → "**恰好一个** observer（activity-runtime）"，且 HTML **现在**加载 `observation-core`；这是 P27-3 的**本意** |
| `test_p26_closure_guard.js`（C3 允许清单） | **A** | `INTENTIONALLY_LOADED` 加入 `observation-core.js` |
| `test_p27_2_activity_created_event_guard.js`（E7） | **A** | 其"只加载一个 P26 core"断言随 P27-3 前进而更新为"加载 domain-event + observation" |

**HASH_COUPLING_DEBT：记录并延续。** P27-2 已需要 7 处整文件哈希更新；P27-3 **再次**
需要同一批 7 处更新（类别 **B**：被守护的不变量未变，纯因"整文件哈希 + 共享文件耦合"）。
这是**第 2 次**重复 ⇒ 按 §28 记 **HASH_COUPLING_DEBT**，留给 **P27-C** 决定是否把
`activity-runtime.js` 的整文件哈希改为**分区/语义锚点**（如"只冻结既有导出面与既有函数体"），
而不是每阶段整文件重签。**本阶段不改守卫体系。**

## 26 Schema/Migration

**无** DB_VER bump（仍 24）· **无**新 store · **无**新 activity 字段 ·
**无** observation 存储（守卫 O10）。

## 27 Worktree

| 文件 | 类型 |
| --- | --- |
| `assets/js/activity/activity-runtime.js` | production（+ `getObservation` 与一处导出） |
| `InternalBeyond.html` | production（+ 1 个 script 标签与说明注释） |
| `docs/P27-3-ACTIVITY-OBSERVATION-INTEGRATION.md` | 新增 |
| `tests/test_p27_3_activity_observation_guard.js` | 新增 |
| `tests/test-all.js` | 注册 |
| `test_observation_core.js` / `test_p26_closure_guard.js` / `test_p27_2_activity_created_event_guard.js` | **语义基线更新（A）** |
| `test_domain_event_core.js` / `test_p25_3e_activity_boundary_audit.js` / `test_p26_0_runtime_requirements.js` / `test_session_core.js` / `test_resource_core.js` / `test_feedback_core.js` | **哈希基线更新（B）** |

**未改**：Cinema（`apps/ib-app-cinema.js`）· Co-read（`coread.js`）· `communication.js` ·
`core.js`（DB 层）· P26 core 模块本体（含 `observation-core.js` 哈希未变）。

## 28 Commit Readiness

**COMMIT DEFERRED BY OWNERSHIP.** 混合所有权工作树；未 stage、未 commit。

## 29 Limitations

- 观察**无 consumer**（今天没有任何订阅者）——它证明"状态可被只读观察"，不证明有人消费。
- `current` / `subtitle` / `frame` 三类候选**有意 DEFER**，理由见 §11/§15/§16。
- 生产 Activity 代码**已变**（新增只读函数）；本阶段未跑浏览器 smoke，
  既有调用路径（create/progress/current/send/nudge/context）**未改**。
- 事件（P27-2）与观察（P27-3）**互不触发**：观察不产生事件，事件不产生观察。
- 冻结哈希耦合债**增加**（§25）：同一文件的整文件哈希被两轮阶段反复重签。

## 30 P27-4 Readiness

**READY，但需先做投影决策。** P27-4（Session Integration）可直接建立在：
`activityId` 作为 entity 身份（本阶段已用）+ `activities` 记录里的
`createdAt` / `lastActiveAt` / `status`（P27-0 已确认足够派生 session 视图）。
**未解决项**正是 §11 的 `current` 语义（pointer 事实 vs 解析结果）——
P27-4 必须先冻结该语义（建议：session 投影**只**读 canonical 记录与指针，**不**调用带写副作用的
`resolveActivity`），再决定是否把 `current` 纳入观察。**无 schema / 无 migration 需求。**

---

## 附录 · Final Questions（Q1–Q16）

1. **实际集成了哪些观察？** 恰好一种：`activity.state`（`IB.activity.getObservation`）。
2. **哪些候选被 DEFER，为什么？** `current`（两个语义 + 读路径带写副作用）、
   `subtitle`（无稳定 valueRef，会退化成内容搬运）、`frame`（需要新持久化）、
   `page`/`progress`（已由 `valueRef` 覆盖，无需独立种类）。
3. **观察是否复制 canonical 状态？** **否**——只带引用（`valueRef`），字段 ⊆ `ALLOWED_FIELDS`。
4. **`valueRef` 到底引用什么？** canonical 存储位置 `activities/<activityId>`。
5. **观察创建会写任何东西吗？** **不会**（O5：0 写入）。
6. **观察会发 Event 吗？** **不会**（O7）。
7. **观察会产生 Feedback 吗？** **不会**（O8）。
8. **观察会唤醒 Agent 吗？** **不会**（O8）。
9. **需要 manager/registry 吗？** **不需要**（领域自有 getter，O9）。
10. **需要 DB migration 吗？** **不需要**（O10，DB_VER 24）。
11. **Cinema frame 今天可安全观察吗？** **不可**（request-local、不持久）⇒ DEFER。
12. **subtitle 今天可安全观察吗？** **不可**（无稳定 valueRef）⇒ DEFER。
13. **P27-3 是否发现 P26-2 契约缺口？** **没有**——观察语义、freshness、availability、
    valueRef 引用形态都能表达真实 Activity 观察。
14. **现在生产加载几个 P26 core？** **2 个**：`domain-event-core` · `observation-core`。
15. **冻结哈希耦合债是否增加？** **是**——同一批 7 个文件**第二次**因整文件哈希重签
    （记 HASH_COUPLING_DEBT，交 P27-C）。
16. **P27-4 Session Integration 是否 ready？** **是**，但须先冻结 `current` 语义
    （只读投影，不得调用带写副作用的 `resolveActivity`）。
