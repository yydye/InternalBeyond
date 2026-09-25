# P27-1 · Activity Lifecycle Closure

阶段性质：**PRODUCTION INTEGRATION / LIFECYCLE SEMANTICS ONLY / MINIMAL CHANGE /
NO NEW WRITER / NO SCHEMA MIGRATION / NO EVENT BUS**。

上游（P27-0，保持不变）：canonical authority = `IB.activity`；`activities` 是 canonical store；
current pointer 不是 session、只是导航投影；Activity 创建 ≠ Session 创建；
Cinema pause ≠ Activity pause；无 Event Bus / 无 Resource 接线 / 无 Wake·Feedback 接线。

---

## 1 State

**P27-1 State: PASS（WITH NOTES）** —— **零 production 变更。**

本阶段把 Activity 生命周期**判定并冻结**为：

- **finish：决策 A —— 今天不需要**（读侧已完整，但**没有任何调用者**需要它；见 §4）。
- **pause / resume：NOT PRESENT**（无真实 Activity 级语义；见 §5 / §6）。
- **delete：保持既有行为**（不加调用者、不改破坏性语义；见 §7）。
- **无新 writer、无新字段、无 DB migration、无 Event Bus、无 P26-5..10。**

Notes：`finished` 是一个**读侧完整、写侧不存在**的状态（可经既有 `saveActivity` 由管理动作到达，
但没有产品路径需要它）。触发重估的条件见 §4 与 §20。

## 2 Existing Lifecycle Reality

```
create (createActivity)
  -> open (findActivity 复用 / createActivity)
  -> current (setCurrent)
  -> progress (setProgress)
  -> leave (clearCurrent)
  -> delete (deleteActivity：存在但无生产调用者)
  X  finish / pause / resume  (NOT PRESENT)
```

**关键事实**：`status==='finished'` 在**读侧**被 5 处尊重
（`_usableFor` 排除 / `setCurrent` 拒绝 / `resolveActivity` 跳过 / `send` 拒绝 / `nudge` 拒绝），
但生产**没有任何写入者**，因此该状态在正常产品路径上**不可达**。

## 3 Status Field Audit

| 名称 | 分类 | 证据 |
| --- | --- | --- |
| `status` | **canonical persisted field** | `createActivity` 写 `'active'`；`saveActivity` 可改 |
| `'active'` | `status` 的**取值**（默认） | 创建时写入 |
| `'finished'` | `status` 的**取值**（读侧已实现，写侧不存在） | 读侧 5 处检查 |
| `'closed'` | **NOT PRESENT** | 全仓无此值 |
| `'deleted'` | **NOT PRESENT**（删除 = 行移除，不是状态） | `deleteActivity` 走 `dbDelete` |
| `lastActiveAt` | **canonical persisted field** | `setProgress` 更新 |
| `progress` / `bookmarks` | **canonical persisted fields** | `setProgress` / `saveActivity` |
| `updatedAt` | **canonical persisted field** | `saveActivity` 每次更新 |
| `resolveActivity` 结果 / current pointer | **derived / pointer** | 投影与本地指针 |
| reader / player 视图、`_pi`、`_pages`、adapter | **UI state / runtime state** | App 内存 |

**先证明缺失再新增**：本阶段**不新增任何字段**（无 `finishedAt`、无 `deletedAt`）。

## 4 Finish Decision

**决策：A —— finish 今天不需要（保持 NOT PRESENT）。**

两条路径都分析过：

| 路径 | 内容 | 判定 |
| --- | --- | --- |
| **B（最小 finish）** | 用既有 `saveActivity` 加一个 `finishActivity(id)`（只改 `status`，无新字段） | **不采用** |
| **A（不引入）** | 保持读侧现状，把"写侧不存在"作为冻结事实记录 | **采用** |

不采用 B 的理由（证据）：

1. **没有调用者**。Cinema 的 close（`unmount`）与 Co-read 的 leave（返回书架）语义都是**离开**，
   不是**结束**（P27-0 已冻结"离开 ≠ 结束"）；产品里**没有**任何"结束活动"入口或需求。
2. **无调用者的新增命令属于投机抽象**。这与 P26-C 对 REDUNDANT_CANDIDATE 的判据一致：
   没有独立 owner / trust / consumer 差异的东西不应新增。P27-0 也把同样无调用者的
   `deleteActivity` 判为"保持既有、不必处理"，本阶段对 finish 采用同一标准。
3. **blast radius 不成比例**。`assets/js/activity/activity-runtime.js` 被 5 个上游守卫
   （`test_p25_3e_activity_boundary_audit.js` 与 P26-1..4 core 套件）**逐字节冻结**；
   为一条无人调用的命令改写 5 个冻结基线，超出"MINIMAL CHANGE"。

⇒ **finish authority / 字段变化 / 可调用时机**：**今天不存在**（全部 NOT PRESENT）。

**重估触发条件（未来阶段）**：出现**真实的结束语义需求**时——
例如用户显式"结束本次活动"入口、或某个域需要"活动已结束"作为事实
（届时 P27-2 的 `activity.finished` 才会变成真正可发事件）。
届时仍必须走**既有** `saveActivity` 路径，且**不加** `finishedAt`（既有 schema 已能表达）。

## 5 Pause Decision

**决策：NOT PRESENT。** 四种候选含义逐一检验，没有一种拥有真实 Activity 级归属：

| "pause" 可能意味着 | 判定 |
| --- | --- |
| user 暂时停止参与 | **无归属**（参与是聊天行为，不是活动状态） |
| media 停止 | **属 media transport**（`IBMedia` adapter），不是 Activity |
| session suspended | **无 session 实体**（P27-0 已冻结 pointer ≠ session） |
| resource released | **无 resource lease**（P26-4 归属契约；P27-5 已 DEFER） |

引入 `activity.pause` 只会制造一个没有 owner 的状态。**不引入。**

## 6 Resume Decision

**决策：NOT PRESENT。** `resume` 语义上依赖 `pause`（已 NOT PRESENT）；
而"继续某个活动"今天**已经**由 `findActivity` + `setCurrent`（重新打开）表达。
不新增第二套"恢复"语义。

## 7 Delete Decision

**保持既有行为，不改。**

| 问题 | 回答 |
| --- | --- |
| 它为何存在？ | 提供活动记录的整体移除（含 legacy thread 清理与指针清理） |
| 谁调用？ | **无生产调用者**（只有导出与测试） |
| delete 是否保持破坏性？ | **保持**（`dbDelete` 行移除）；本阶段**不新增调用者**、不改语义 |

## 8 Final Lifecycle Diagram

```
                    createActivity
                          |
                          v
   +----------------> status: 'active' <----------------+
   |                      |  ^                          |
   |        setCurrent    |  | setCurrent               |
   |     (仅 active)      v  | (仅 active, 幂等)        |
   |                  current pointer --> resolveActivity 投影
   |                      |
   |        setProgress   v
   |                  progress (canonical)
   |                      |
   |        clearCurrent  v   (leave: 只清指针, 不改 status)
   |                    (无 status 变化)
   |
   |   (无 finish 边: P27-1 决策 A)
   |
   +-- deleteActivity (既有, 破坏性, 无生产调用者)
        +--------------------> 记录被移除 (含 legacy thread + 指针清理)

   旁路 (非 lifecycle 命令): saveActivity(id,{status:'finished'})
        -> 读侧随即生效 (setCurrent 拒绝 / resolveActivity 跳过 /
           send 拒绝 / nudge 拒绝) —— 但产品无调用者, 属管理动作
```

## 9 Invalid Transitions

| 非法转移 | 今天如何被阻止 |
| --- | --- |
| `setCurrent` on finished | **拒绝**（返回 `null`） |
| `send` on finished | **拒绝**（`{ok:false,error:'activity_finished'}`，不 fallback） |
| `nudge` on finished | **拒绝**（返回 `false`） |
| `resolveActivity` 选中 finished | **跳过**（并顺手清理失效指针） |
| `finish` after `delete` | **不存在该命令**（无 finish） |
| `create` after `delete` | **允许**（新 id，两条不同记录） |
| `progress` after finished（管理动作置位后） | **语义非法**；调用方保证（`send` 先拒 finished；App 关闭后不再调 `setProgress`）。**写侧未强制**（见 §20） |

## 10 Writer Ownership

| 项 | 结论 |
| --- | --- |
| canonical writer | **仍是且仅是 `IB.activity`**（`activity-runtime.js` 的 `dbPut/dbDelete('activities')`） |
| 本阶段新增 writer | **无** |
| 新增 store / 字段 | **无** |
| 指针写入 | 仍是 localStorage（`ib_activity_current_v1`）+ 内存兜底，**不是 canonical** |
| `activity-runtime.js` | **逐字节未变**（哈希仍是 `A65DEA34…2E1DC225`） |

## 11 Session Boundary

- **Activity ≠ Session**（不变）。
- **无 `sessionId` 字段、无 session store、无 `session-core` 依赖、无 DB migration。**
- 若未来需要 session 视图，只允许**派生投影**（P27-4 议题），不新增持久面。

## 12 Cinema Compatibility

| 行为 | 状态 |
| --- | --- |
| Cinema close（`unmount`） | 仍是 `clearCurrent(_aiId,_activity.id)` + `_destroyCurrent()` + 清 `subs`；**不 finish** |
| Cinema pause | 仍是 **media transport**（`IBMedia` adapter），**未**变成活动命令 |
| 进度 / 留影 / 发送 | 仍经 `IB.activity.setProgress` 与 `send(visionReference)`，未变 |

## 13 Co-read Compatibility

| 行为 | 状态 |
| --- | --- |
| 翻页 | 仍 `setProgress`（canonical） |
| 书签 | 仍 `saveActivity({bookmarks})`（canonical） |
| 返回书架（leave） | 仍 `clearCurrent(roleId, id)`，**不 finish** |

**无 lifecycle 扩张。**

## 14 Event Future Points

**本阶段不发任何 event**（P27-2 议题）。候选矩阵**不变**：

| 候选 | 判定 |
| --- | --- |
| `activity.created` | **READY**（真实事实 + 唯一 writer + 安全发点） |
| `activity.progressed` | NOT READY（高频，属 observation） |
| `activity.finished` | **NOT READY**（无写入者；见 §4 重估触发条件） |
| `activity.deleted` | NOT READY（无调用者、无消费者） |

铁律不变：`canonical writer succeeds -> future event`；**禁止** `event -> writer`。

## 15 Observation Future Points

不创建 Observation adapter / manager / registry。
可观察的生命周期事实（`status`、`lastActiveAt`、`progress`）都在 canonical record 上，
可被**纯投影**读取（P27-3 议题）。

## 16 Memory / Nudge Boundary

**不变。** Memory 仍是 Memory（`writeMemory` 委托 `quickCreateMemory`）；
`nudge` 仍是 Active Message 计划（8 分钟冷却 + 幂等），**不是 Agent Wake**；
**未接 P26-5..10**。

## 17 Tests

| 套件 | 作用 |
| --- | --- |
| `tests/test_p27_1_activity_lifecycle_guard.js`（**新增**，11 checks） | 生命周期契约 + **vm 语义探针**（证明读侧契约完整、且无 lifecycle 命令） |
| `tests/test_p27_0_activity_wiring_guard.js` | P27-0 证据守卫（**未改动**，10 checks） |
| `tests/test_p25_3e_activity_boundary_audit.js` | 边界守卫（**未改动**，16 checks） |
| `tests/test_domain_event_core.js` … `test_resource_core.js` | P26-1..4 core（**未改动**） |
| `tests/test_p26_closure_guard.js` | P26 冻结（**未改动**） |
| `tests/test_activity_smoke.js` | **浏览器**行为（本阶段未跑；零 production 变更） |

**未修改任何上游测试**（因为零 production 变更）。

## 18 Worktree

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `docs/P27-1-ACTIVITY-LIFECYCLE-CLOSURE.md` | 新增 | 本文件 |
| `tests/test_p27_1_activity_lifecycle_guard.js` | 新增 | 生命周期守卫 |
| `tests/test-all.js` | 更新 | 注册 P27-1 守卫 |

**production 零变更**：`assets/js/activity/activity-runtime.js` 逐字节未变（`A65DEA34…2E1DC225`）；
Cinema / Co-read / communication / `core.js` 未变；`InternalBeyond.html` 未变；`DB_VER = 24` 未变。

## 19 Commit Readiness

**COMMIT DEFERRED BY OWNERSHIP.** 混合所有权工作树；未 stage、未 commit。

## 20 Limitations

- **`finished` 在正常产品路径不可达**：读侧完整、写侧不存在。这是**有意的**决策结果，
  不是遗漏；重估触发条件见 §4。
- **写侧不强制 status 前置条件**：`saveActivity` / `setProgress` 不检查 `finished`（延续既有语义）。
  若未来需要强约束，应作为独立议题（并评估对 legacy 路径的影响）。
- `deleteActivity` 仍无生产调用者；`activity.mark` 仍保持既有机制。
- 未跑浏览器 smoke（本阶段零 production 变更，只做 Node 语义探针 + 结构守卫）。
