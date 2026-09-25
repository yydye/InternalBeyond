# P27-4 · Activity Session Projection Integration
阶段性质：**PRODUCTION INTEGRATION / READ-ONLY SESSION PROJECTION / MINIMAL WIRING /
NO SESSION STORE / NO SESSION MANAGER / NO MIGRATION / NO EVENT BUS / NO COMMIT**。
上游冻结（保持）：P27-0（Activity 生产审计）· P27-1（finish/pause/resume NOT PRESENT）·
P27-2（唯一 Domain Event = `activity.created`）· P27-3（唯一 Observation = `activity.state`，
并要求先冻结 `current` 语义）。
---
## 1 State
**P27-4 State: PASS（WITH NOTES）**
- 集成**一个只读 Session 投影**：`IB.activity.getSession(activityId)` —— 把 canonical Activity 记录投影成 P26-3 Session。
- **不需要** `current` 指针（可由记录独立派生）；**不调用** `resolveActivity`（带写副作用）；**不调用** `transitionSession`（迁移能力仍只属纯 foundation）。
- **无** SessionManager / Registry / Store；**无**新持久化 / 新字段 / DB 变更。
- Notes：`activity-runtime.js` 与 `InternalBeyond.html` **第三次**改动 ⇒ **HASH_COUPLING_DEBT = CONFIRMED STRUCTURAL TEST DEBT**（见 §24）。
## 2 P26-3 Contract Audit
| 项 | 值（来自 `assets/js/session-core.js`） |
| --- | --- |
| API | `createSessionIdentity` · `createSession` · `validateSession` · `canTransitionSession` · `transitionSession` |
| REQUIRED | `sessionId` · `domain` · `participants`（非空、≤32、唯一可用 id）· `status` · `createdAt` |
| OPTIONAL | `updatedAt` · `endedAt`（**可选**，仅在出现时校验） |
| status 闭集 | `created` / `active` / `ended` / `failed`（终态 `ended`/`failed`） |
| 正文拒绝 | `RESERVED_STATE_FIELDS`（messages/content/history/memory/…） |
| 关键约束 | `createSession` **恒把 status 置为 `created`**（创建 ≠ 开始）；`transitionSession` 才产出 `active`/`ended` |
⇒ 投影**不能**直接用 `createSession` 产出 `active`/`ended`，因此：**先复用 `createSession` 做身份 + 参与者规范化 + 校验**，再按映射改写 status 并用 **`validateSession` 复验**。两者都来自 P26-3 ⇒ **不复制** session/v1、状态词表、参与者校验、身份规则。
## 3 Activity Fact Classification
| Activity 事实 | 分类 | 说明 |
| --- | --- | --- |
| `id` | **SESSION INPUT** | → `sessionId`（复用；不新增持久身份） |
| `roleId` | **SESSION INPUT** | → `participants: [roleId]`（role-only） |
| `status`（active/finished） | **SESSION INPUT** | → `active` / `ended` 映射 |
| `createdAt` | **SESSION INPUT** | → `createdAt`（直接） |
| `updatedAt` | **SESSION INPUT（有保留）** | → `updatedAt`（记录最近写入时刻，见 §9） |
| `lastActiveAt` | **PROJECTION HINT** | 本轮**不**映射（它是进度活动度，不是生命周期） |
| `progress` / `bookmarks` / `recap` | **DOMAIN-ONLY** | canonical 业务状态；**严禁**进入 Session |
| `title` / `resourceId` / `kind` / `type` | **DOMAIN-ONLY** | 不映射 |
| current 指针（`ib_activity_current_v1`） | **PROJECTION HINT** | 导航提示；本轮**不使用**（§5） |
| `threadId`（legacy） | **NOT SESSION DATA** | 历史频道锚 |
## 4 Current Semantics（冻结）
**current 指针的含义（冻结措辞）**："该角色当前在界面上选中 / 挂接了这个 Activity" —— 即**导航 / 运行时选择提示**（可重建）。
**它是**：navigation / runtime selection hint。
**它不是**：canonical lifecycle state · Session identity · Session authority · Session ownership · Activity status。
**推论（冻结）**：**缺失指针 ≠ Session 结束**；**陈旧指针在投影期间不得被清理 / 改写**。
## 5 Pointer Necessity Decision
**结论：不需要。** 能否仅由 Activity 记录派生一个**合法** P26-3 Session？**能**（`sessionId=activityId`、`participants=[roleId]`、`status` 映射、`createdAt` 直取）。
因此 §6 的判据满足 ⇒ **不涉及 current 指针**，指针保持纯 UI/导航语义。§5 的 A/B 选择：**B（omit pointer from Session projection）**；**未**新增任何指针读取 helper，**未**触碰 `resolveActivity`（它仍带既有 stale-pointer 清理副作用，属其它读路径）。
## 6 Session Identity
`sessionId = activityId`（**复用**）。实现上通过 `createSession({sessionId: activityId, ...})` 走 P26-3 的**身份注入**路径（`createSessionIdentity` 优先接受注入 id）⇒ **未**新增 `sessionId` 字段到 Activity、**未**建映射表、**未**建身份派生持久 ID。**无重复身份。**
## 7 Session Creation Semantics
**Activity creation ≠ Session creation**（P27-0/P27-1 冻结）：`createActivity` **不**调用 `createSession`，创建 Activity 时**不产生** Session 副作用（守卫 S18）。Session 只在**读取时**投影（`getSession`），是纯函数式读取模型。
## 8 Status Mapping
| Activity `status` | Session `status` | 依据 |
| --- | --- | --- |
| `'active'` | **`active`** | 直接对应 |
| `'finished'` | **`ended`** | 读侧承认的管理态映射为终态（P27-1 决策 A 不变：**无 finish 命令**） |
| 其它 / 缺失 | **`null`（fail closed）** | 不发明 `created` / `failed` |
映射结果还会与 `core.SESSION_STATUSES` 比对：若 P26-3 词表里没有该值 ⇒ 返回 `null`（**词表权威仍在 P26-3**）。**不伪造** `created` / `failed`：仓库里没有对应事实（Activity 无"未开始"或"失败"态）。
## 9 Timestamp Mapping
| Session 字段 | 来源 | 说明 |
| --- | --- | --- |
| `createdAt` | `rec.createdAt` | 直接映射 |
| `updatedAt` | `rec.updatedAt` | 记录**最近写入**时刻。**注意**：Activity 的 `updatedAt` 由任意 `saveActivity` 更新（**含**进度写回），因此它**不是**生命周期迁移时刻；P26-3 的 `updatedAt` 本由 transition 写入 —— 这是"记录级 last-write"与"生命周期 last-change"的**语义差**，已显式记录，不隐藏。 |
| `endedAt` | **不提供** | Activity **没有** `finishedAt`。P26-3 中 `endedAt` 为**可选** ⇒ **无契约缺口**，**不发明**时间戳。 |
`lastActiveAt` **未**用于 `updatedAt`：它只由进度写回更新，比 `updatedAt` 更偏"活动度"，与"会话状态最后更新"更远。
## 10 Participant Mapping
审计结论：仓库里**没有** canonical user participant id。唯一的"用户身份"是 `communication.js` 的 `_cachedUserName`（来自 `about/main` 的**显示名**），既不是 canonical id，也不属 Activity 域。⇒ 采用 §12 的**选项 B**：**role-only** participants `[roleId]`（P26-3 允许单参与者）。**未发明** `'user'` / `'self'` / `'me'`；**未**给 Activity 增加 participants 字段。
## 11 Production API
```
IB.activity.getSession(activityId) -> session | null
```
- **只读**；返回合法 P26-3 Session 或 `null`；**绝不抛错**。
- **无**持久化 / **无**生命周期迁移 / **无**指针清理 / **无** Event / Observation / Feedback / Wake。
- **无** `ActivitySessionManager` / `SessionRegistry` / `SessionService`。
- 命名 `getSession`（裸名与 P25-3E 的 NOT_PRESENT 清单无碰撞）。
## 12 Ownership
| 关注点 | 所有者 |
| --- | --- |
| 状态本体 | `IB.activity` / `activities` store（未变） |
| 投影 producer | **`IB.activity`**（领域自有只读投影） |
| 契约 | P26-3 `session-core.js`（唯一） |
| Session 持久化 | **不存在** |
投影**不是**第二权威：它不写任何东西，只是读取模型。
## 13 Read-only Proof
守卫 **S7**（单次 `getSession` 窗口）：`dbPut` + `dbDelete` + localStorage 写 = **0**。**S9**：陈旧指针不触发清理写。**S20**：核心缺失 ⇒ `null` 且 0 写。**S15b**（源码断言）：`getSession` 函数体内不出现 `resolveActivity` / `localStorage` / `dbPut` / `dbDelete`，只出现 `getActivity(`。源码中**无** `chatMessages` / `memories` / `active_message_plans` 写入。
## 14 Cinema Compatibility
Cinema **未改**（哈希 `CE581CF2…65B97B58` 未变）：open/reuse、`setCurrent`、progress、`clearCurrent`（close）全部保持。**关闭 Cinema ≠ 结束 Session**：close 只 `clearCurrent` + 销毁 media runtime；`getSession` 之后仍从 canonical 记录投影出 `active` Session（守卫 **S8** 用"无指针"场景证明"指针缺失 ≠ Session 结束"）。
## 15 Co-read Compatibility
Co-read **未改**（哈希 `C3DCBD8D…1D0ACAAD` 未变）：翻页 / 书签 / 返回书架（`clearCurrent`）语义不变；离开阅读器**不**结束投影出的 Session。
## 16 Event Boundary
Session 投影**不发**任何 Domain Event：**未**新增 `activity.session_started` / `activity.session_ended` / `session.created`。守卫 **S12**：投影期间 Domain Event 创建数 = **0**；P27-2 的 `activity.created` 仍是唯一生产事件（**S18** 回归证明）。
## 17 Observation Boundary
**未**由 Session 投影创建第二个 Observation（**S13**：投影期间 Observation 创建数 = **0**）。P27-3 的 `activity.state` 仍是唯一观察（**S19** 回归证明）。Session ≠ Observation；两者是**各自独立**的读取模型，互不自动触发。
## 18 Feedback/Wake Boundary
零 P26-5..10 生产引用（**S14**）。Session 存在 / 当前性**不**产生 Feedback、**不**创建 Wake Request、**不**唤醒 Agent。
## 19 Resource Boundary
**未**集成 P26-4（**S17** 断言 `resource-core.js` 不加载）：投影**不** claim 播放面、**不**锁资源、**不**评估冲突。P27-5 仍 **DEFER**。
## 20 Failure Semantics
```
canonical Activity 读取失败 / 缺失  -> 无投影（null） -> canonical 不变
P26-3 校验失败                     -> null           -> canonical 不变
session-core 缺失                  -> null           -> canonical 不变（S20）
指针缺失                           -> 不影响 Session（S8）
指针陈旧                           -> 投影**不**清理指针（S9）
投影失败                           -> 不影响 Activity / Event / Observation
```
实现整体 `try/catch`，**绝不**抛错，**绝不**回滚或修复 canonical Activity。
## 21 HTML/Core Loading
新增一行（紧随 `observation-core.js`）：
```
<script src="assets/js/domain-event-core.js"></script>   <!-- P27-2 -->
<script src="assets/js/observation-core.js"></script>    <!-- P27-3 -->
<script src="assets/js/session-core.js"></script>        <!-- P27-4 -->
```
**生产加载的 P26 core 现在恰好 3 个**：domain-event · observation · session（**S17**）。`resource` / `feedback` / `feedback-consumption` / `wake-request` / `wake-runtime` / `activation-intent` / `activation-runtime` **均未加载**。
## 22 Tests
新增 `tests/test_p27_4_activity_session_projection_guard.js`（**20 checks**，vm + 桩真实执行）：
| check | 内容 |
| --- | --- |
| S1 | active Activity → 合法 P26-3 Session |
| S2 | `sessionId === activityId`；Activity 记录**未**新增 `sessionId` 字段 |
| S3 | participants = `[roleId]`（有据可依的 role-only） |
| S4 | `active` → `active` |
| S5 | 管理态 `finished` → `ended`，且**不**发明 `endedAt` |
| S6 | 缺失 / 空 id → `null` |
| S7 | **投影零写入** |
| S8 | **指针缺失 ≠ Session 结束** |
| S9 | 陈旧指针**无**清理写 |
| S12 | 投影**不发** Domain Event |
| S13 | 投影**不产生** Observation |
| S14 | 无 Feedback / Wake / Agent |
| S15 / S15b | 无 Manager/Store/Registry；函数体不调用 `resolveActivity`、不写存储 |
| S16 | `DB_VER` 仍 24、无 session store |
| S17 | 只加载 3 个预期 P26 core |
| S18 / S19 | P27-2 `activity.created` / P27-3 `activity.state` 行为保持 |
| S20 | 核心缺失 ⇒ `null` + 0 写 |
| S21 | 未知状态 fail closed |
## 23 Regression
| 套件 | 结果 |
| --- | --- |
| P27-4 guard（新增） | 20 PASS |
| P27-3 / P27-2 / P27-1 / P27-0 | 13 / 7 / 11 / 10 PASS |
| P26-3 / P26-2 / P26-1 / P26-4 | 24 / 32 / 42 / 22 PASS |
| P26-5 / P26-0 / P26 closure | 19 / 17 / 8 PASS |
| P25-3E activity boundary | 16 PASS |
| P25-3A registry / orchestration · Autonomy | 13 / 28 / 41 PASS |
| **Activity 浏览器 smoke**（activity-runtime 变了） | **PASS**（`Activity/Favorites/AppStore smoke passed`） |
| `test_frontend_structure.js` | 仍 6 个既有 BOM 失败（无新增） |
## 24 Frozen Guard Re-baseline
| 文件 | 类别 | 说明 |
| --- | --- | --- |
| P26-1(G6) · P26-2(G8) · P26-4(G8) · P26-5(G8) · P25-3E(A14) · P26-0(R1/R15) | **B** | 整文件哈希变化；被守护不变量未变 |
| **P26-3**(G1.g7 语义 + G8 哈希) | **A** | "production sessions = 0" → "**恰好一个**投影者"；HTML 现在加载 `session-core`；并断言**不**生产接线 `transitionSession` |
| P26-2(G1.g7) | **A** | 其"其它 core 不得加载"清单移除 `session-core.js`（P27-4 有意加载） |
| P26 closure(C3) | **A** | `INTENTIONALLY_LOADED` += `session-core.js` |
| P27-1(L6) | **A** | 由"源码不得出现 `sessionId`"细化为"Activity **记录**不含 session 身份 / 无 session 存储 / 无 session 生命周期" |
| P27-2(E7) · P27-3(O11) | **A** | 核心加载清单随 P27-4 前进 |
**HASH_COUPLING_DEBT = CONFIRMED STRUCTURAL TEST DEBT.** P27-2（第 1 次）、P27-3（第 2 次）与 **P27-4（第 3 次）**都对**同一批 7 个文件**做了 B 类整文件哈希重签 —— 被守护的不变量从未变，变的只是 `activity-runtime.js` 的整文件哈希。按 §30，这已构成**结构性测试债**：**P27-C 必须决定**是否把 Activity 相关的整文件哈希守卫替换为**语义 / 分区锚点**（例如只冻结既有导出面 + 既有函数体，允许新增领域自有 getter）。**本阶段不做该重构。**
## 25 Schema/Migration
**无** DB_VER bump（仍 24）· **无**新 store · **无**新 Activity 字段 · **无** sessionId 持久化 · **无** participants 持久化（**S16**）。
## 26 Worktree
| 文件 | 类型 |
| --- | --- |
| `assets/js/activity/activity-runtime.js` | production（+ `getSession` 与导出） |
| `InternalBeyond.html` | production（+1 script 标签与说明注释） |
| `docs/P27-4-ACTIVITY-SESSION-PROJECTION-INTEGRATION.md` | 新增 |
| `tests/test_p27_4_activity_session_projection_guard.js` | 新增 |
| `tests/test-all.js` | 注册 |
| `test_session_core.js` / `test_observation_core.js` / `test_p26_closure_guard.js` / `test_p27_1_activity_lifecycle_guard.js` / `test_p27_2_activity_created_event_guard.js` / `test_p27_3_activity_observation_guard.js` | **语义基线（A）** |
| `test_domain_event_core.js` / `test_p25_3e_activity_boundary_audit.js` / `test_p26_0_runtime_requirements.js` / `test_resource_core.js` / `test_feedback_core.js` | **哈希基线（B）** |
**未改**：Cinema · Co-read · `communication.js` · `core.js`（DB 层）· P26 core 模块本体。
## 27 Commit Readiness
**COMMIT DEFERRED BY OWNERSHIP.** 混合所有权工作树；未 stage、未 commit。
## 28 Limitations
- Session 投影**无消费者**（今天没有调用方）——它证明"记录可被只读投影成合法 Session"。
- `updatedAt` 是**记录级 last-write**（含进度写回），**不是**生命周期迁移时刻；P26-3 原本用它表达"迁移时间"，此处为投影语义差，已显式记录。
- `endedAt` **不提供**（无 `finishedAt` 事实）；`failed` / `created` **不产生**（无事实）。
- participants 仅角色；**没有**用户参与者（仓库无 canonical user id）。
- 冻结哈希耦合债已确认结构性（§24）。
## 29 P27-5 Decision
**P27-5（Resource Conflict Integration）仍为 DEFER。** 本次审计**未**发现新的真实冲突证据：投影不 claim 任何资源；Cinema 播放面仍由单实例 adapter 串行化；Activity 记录并存在今天**不是**资源冲突（指针只做选择）。若 P27-C 决定关闭 P27，P27-5 应以 **DEFER / NOT REQUIRED** 结算，而非补造场景。
## 30 P27-C Readiness
**READY。** P27 的生产接线面现在恰好三项（event / observation / session），全部**只读或只发事实**、零新持久化、零新权威、零 Bus。P27-C 需要处理两件事：① **HASH_COUPLING_DEBT**（把 Activity 整文件哈希守卫改为语义 / 分区锚点）；② P27-5 的**结算**（DEFER / NOT REQUIRED）与 P27 的 closing criteria。
---
## 附录 · Final Questions（Q1–Q21）
1. **构建 Session 是否需要 current 指针？** **不需要**（记录独立充分）。
2. **current 到底是什么意思？** "该角色当前在界面上选中 / 挂接了这个 Activity"——导航 / 运行时选择提示。
3. **指针缺失会结束 Session 吗？** **不会**。
4. **陈旧指针会在投影中触发变更吗？** **不会**（零清理写）。
5. **sessionId 是什么？** `activityId`。
6. **是否持久化了任何 session 身份？** **没有**。
7. **`active` 如何映射？** → `active`。
8. **`finished` 如何映射？** → `ended`。
9. **`endedAt` 从哪来？** **无来源**（Activity 无 `finishedAt`）⇒ 不提供；P26-3 中它是可选的。
10. **participants 是谁？** `[roleId]`（role-only）。
11. **是否发明了假用户身份？** **没有**。
12. **`getSession` 会写任何东西吗？** **不会**（S7）。
13. **会发 Event 吗？** **不会**（S12）。
14. **会创建 Observation 吗？** **不会**（S13）。
15. **会触发 Feedback/Wake 吗？** **不会**（S14）。
16. **需要 Session Manager 吗？** **不需要**（S15）。
17. **需要 DB migration 吗？** **不需要**（S16，DB_VER 24）。
18. **现在生产加载几个 P26 core？** **3 个**（domain-event · observation · session）。
19. **哈希耦合债是否变成结构性？** **是**（第 3 次 B 类重复 ⇒ CONFIRMED STRUCTURAL TEST DEBT，交 P27-C）。
20. **P27-5 还需要做吗？** **无新证据**；应以 DEFER / NOT REQUIRED 结算。
21. **P27 是否可以进入 closure？** **可以**（接线面 3 项，全部只读 / 只发事实，零新权威）。
