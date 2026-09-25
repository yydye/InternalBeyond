# P27-2 · Activity Created Domain Event Integration

阶段性质：**PRODUCTION INTEGRATION / MINIMAL EVENT WIRING / ONE EVENT ONLY /
NO EVENT BUS / NO MANAGER / NO MIGRATION**。

上游冻结（保持）：`IB.activity` 是 canonical writer · `activities` 是 canonical state ·
current pointer 不是 authority · Activity ≠ Session · finish / pause / resume NOT PRESENT ·
delete 不变 · 无 DB migration · 无 Event Bus。

---

## 1 State

**P27-2 State: PASS（WITH NOTES）**

- 接线**恰好一个** Domain Event：**`activity.created`**。
- 顺序：`createActivity` canonical 写入（`dbPut('activities')`）**成功之后**才创建事件。
- 事件**不落库**；事件失败**不回滚** canonical Activity。
- **无 consumer**（不建 Event Bus / Router / Listener / Manager）。
- **不复制** P26-1 事件契约（复用 `createDomainEvent`）。
- DB_VER 仍 **24**；无新 store；Cinema / Co-read / communication.js **未改**。

Notes：本阶段有意打破 P26-1 的 "foundation-only" 先例——`domain-event-core.js` **现在**被
生产 HTML 加载（与 P25-2C 给 `autonomy-core` 补依赖同一先例），并同步更新了
P26-1 / P26 closure / P26-0 / P25-3E 等**冻结基线**（见 §10）。

## 2 P26 Event Core usage

审计（不复制契约）：

| 项 | 值（来自 `assets/js/domain-event-core.js`） |
| --- | --- |
| API | `createDomainEvent(input, options)` · `validateDomainEvent(event, options)` · `orderingKeyFor` · `dedupeKeyFor` |
| version | `domain-event/v1` |
| REQUIRED | `eventId`（可确定性派生）· `domain` · `type` · `entityId` · `timestamp` |
| OPTIONAL | `actorId` · `origin` · `causationId` · `correlationId` |
| 闭集 | `ALLOWED_FIELDS`（10 个）；未知字段与正文字段**一律拒绝** |

`activity-runtime.js` **只**调用 `window.IBDomainEventCore.createDomainEvent(...)`：
源码中**没有** `domain-event/v1` 字面量、**没有** 自定义 `validateDomainEvent`
（守卫 E7 断言）⇒ 契约唯一持有者仍是 P26-1。

## 3 Writer seam

精确接缝（`assets/js/activity/activity-runtime.js` → `createActivity`）：

```
try{await dbPut(ACT_STORE,rec)}catch(e){return null}   <-- canonical 写入
_emit(rec.id,'activity',rec);                          <-- 既有本地回调（未变）
_emitActivityCreated(rec);                             <-- P27-2 唯一新增（事件）
return rec;
```

`_emitActivityCreated(rec)` 是私有 helper：惰性解析核心、构造最小输入、调用
`createDomainEvent`，成功则经**既有**本地回调通道 `_emit(rec.id,'created',event)` 广播。

**未触碰**：Cinema（`apps/ib-app-cinema.js`）· Co-read（`assets/js/activity/coread.js`）·
`assets/js/communication.js`（三者哈希未变）。HTML 仅新增一行 `domain-event-core.js`
（放在 `chat-core` / `voice-message-core` **之后**，因为核心的 `stableToken` 依赖它们；
而 activity-runtime 是**惰性**解析核心，所以加载顺序不影响正确性）。

## 4 Event shape

最小载荷（只带**引用**）：

```
{
  eventId,        // 由核心确定性派生 'evt_<token>'（同一事实可去重）
  domain: 'activity',
  type: 'created',
  entityId: <activityId>,   // 唯一实体引用
  actorId: <roleId>,        // 可选；角色引用
  origin: 'runtime',        // 可选；生产者步骤
  timestamp: <rec.createdAt>
}
```

**`activityId` 是否足够？** **足够**：`entityId` 就是 canonical 记录的 id，
域内可据此定位记录、角色、类型与进度——无需把记录内容复制进事件。

**禁止项（已由 P26-1 契约与守卫 E3 双重保证）**：完整 Activity 对象 · 聊天历史 ·
记忆 · 媒体帧 · 字幕 · API key / token / 凭证 · `progress` / `bookmarks` / `title`。
守卫 E3 断言事件字段 ⊆ `ALLOWED_FIELDS`、无正文关键词、且**小于**记录本身。

## 5 Ownership

| 关注点 | 所有者 |
| --- | --- |
| 事件**生产者** | **`IB.activity`**（不是 Event Core / Cinema / Co-read / Chat） |
| 事件**契约** | P26-1 `domain-event-core.js`（唯一） |
| canonical Activity | `IB.activity`（唯一 writer，未变） |
| 投递通道 | **既有**本地回调 `_emit`（未新增通道） |

## 6 Failure semantics

```
canonical 写入失败        -> createActivity 返回 null，**不产生事件**（E4）
canonical 写入成功        -> 创建事件（E1）
事件创建/投递失败/核心缺失 -> canonical Activity **仍成功**，**不回滚**（E5）
```

`_emitActivityCreated` 内部整体 `try/catch`，**永不抛错**；核心缺失、返回 `ok:false`、
或抛异常三种情况都被验证为"canonical 不变"（守卫 E5）。

## 7 Persistence

- **无** event store / event history / event queue。
- `DB_VER` 仍 **24**；`core.js` store 列表**未变**（守卫 E6 断言无
  `domainEvents` / `events` / `eventStore` / `eventHistory` / `eventQueue`）。
- 事件是**瞬时对象**，只存在于内存与本地回调。

## 8 Consumer boundary

- **不创建** consumer：无 Event Bus · 无 Router · 无 subscribe / listener · 无 Manager。
- 事件经**既有**本地回调广播 ⇒ **"事件可以存在而没有消费者"**（今天确实没有订阅者）。
- 铁律保持：`canonical writer succeeds -> event`；**禁止** `event -> writer`。

## 9 Tests

新增 `tests/test_p27_2_activity_created_event_guard.js`（**7 checks**，vm + 桩真实执行）：

| check | 内容 |
| --- | --- |
| E1 | `createActivity` 成功 → **恰好一个**事件且通过 P26-1 校验 |
| E2 | 事件携带 `activityId`（`entityId`）+ `actorId` + `origin` + `timestamp` |
| E3 | 事件**不含** Activity 正文 / 聊天历史 / 记忆 / 帧 / 字幕 / 凭证；且小于记录本身 |
| E4 | canonical writer 失败 → `null` 且**零事件** |
| E5 | 事件失败（抛错 / `ok:false` / 核心缺失）→ Activity **仍创建**（不回滚） |
| E6 | 无 Event Bus / Manager / event store；DB_VER 24 |
| E7 | 接缝在 canonical 写入**之后**；恰一个调用点；不复制契约；**仅此一个事件**；只加载一个 P26 core |

## 10 Regression

| 套件 | 结果 |
| --- | --- |
| P27-2 guard（新增） | 7 PASS |
| P27-1 / P27-0 guards | 11 / 10 PASS |
| P26-1..10 core | 42 / 32 / 24 / 22 / 19 / 38 / 26 / 27 / 23 / 24 PASS |
| P26-0 requirements / P26 closure guard | 17 / 8 PASS |
| P25-3E activity boundary | 16 PASS |
| P25-3A registry / orchestration | 13 / 28 PASS |
| Autonomy Core | 41 PASS |

**本次有意重新基线的冻结项（生产接线的必然代价）**：

| 文件 | 变更 |
| --- | --- |
| `test_domain_event_core.js`（P26-1） | emitter 断言 `Zero` → **`ActivityOnly`**；HTML 断言反转为"**加载** core"；G6 哈希 |
| `test_p26_closure_guard.js`（P26-C） | C3 允许**唯一** `domain-event-core.js`；C7 允许**唯一** consumer `activity-runtime.js` |
| `test_p26_0_runtime_requirements.js`（P26-0） | frozen 哈希 |
| `test_p25_3e_activity_boundary_audit.js` / `test_observation_core.js` / `test_session_core.js` / `test_resource_core.js` / `test_feedback_core.js` | frozen 哈希（`activity-runtime.js`） |

`activity-runtime.js`：`A65DEA34…2E1DC225` → **`3CA23C81…9A855542`**。
`InternalBeyond.html`：`954A9CA2…FA1C50B2` → **`290EE27D…DAB2B77F9`**。

## 11 Worktree

| 文件 | 类型 |
| --- | --- |
| `assets/js/activity/activity-runtime.js` | production（+ helper 与一处调用） |
| `InternalBeyond.html` | production（+ 1 个 script 标签与说明注释） |
| `docs/P27-2-ACTIVITY-CREATED-EVENT-INTEGRATION.md` | 新增 |
| `tests/test_p27_2_activity_created_event_guard.js` | 新增 |
| `tests/test-all.js` | 注册 |
| `test_domain_event_core.js` / `test_p26_closure_guard.js` / `test_p26_0_runtime_requirements.js` / `test_p25_3e_activity_boundary_audit.js` / `test_observation_core.js` / `test_session_core.js` / `test_resource_core.js` / `test_feedback_core.js` | **冻结基线更新** |

**未改**：Cinema · Co-read · communication.js · core.js（DB 层）· P26 core 模块本体 ·
四个域权威 · P23 / P24 / P25。

## 12 Commit readiness

**COMMIT DEFERRED BY OWNERSHIP.** 混合所有权工作树；未 stage、未 commit。

## 13 Limitations

- 事件**无消费者**（有意）：它证明"域事实可表达"，但今天没有任何订阅者。
- `activity.progressed` / `activity.finished` / `activity.deleted` **仍未接**（前者高频、
  中者无 writer、后者无调用者）。
- 事件**不落库**：页面重启后无法回放（符合 P26-0 "优先 canonical state 重建"）。
- `actorId` 依赖 `roleId` 满足 P26-1 的 ID 语法；不满足时事件静默跳过（canonical 不受影响）——
  这是 fail-closed 的**事件层**行为，不是错误。
- 未跑浏览器 smoke（Node 语义探针已覆盖接缝；生产副作用仅一次 `dbPut` 后的一次纯函数调用）。
