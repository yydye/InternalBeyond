# P27 · Activity Production Integration Closure Report
阶段性质：**CLOSURE / PRODUCTION-INTEGRATION AUDIT / TEST-ARCHITECTURE CLEANUP /
NO NEW DOMAIN FEATURE / NO NEW P26 WIRING / NO RESOURCE INTEGRATION / NO EVENT BUS**。
---
## 1 State
**P27 CLOSURE: PASS WITH NOTES** —— **P27 LOGICALLY FROZEN**。
准确措辞（§31）：**P27 proved selected P26 runtime contracts in one real production domain.**
（**不是**"P27 fully integrated all P26 contracts"。）
P27 的生产接线面**恰好三项**：`activity.created`（P26-1）· `activity.state`（P26-2）·
`IB.activity.getSession(activityId)`（P26-3 只读投影）。P26-4 未接线（证据不支持），
P26-5..10 未接线（无 consumer）。**零新持久化 / 零新权威 / 零 Bus / 零 Manager。**
Notes：本阶段完成了 **HASH_COUPLING_DEBT** 的结构性修复（测试侧语义分区，见 §17–§19）。
## 2 Pilot Goal Result
| 问题 | 结果 |
| --- | --- |
| A. 是否保持 Activity canonical authority？ | **是**（唯一 writer 仍 `IB.activity`） |
| B. Event 是否仍在下游（writer 成功之后）？ | **是** |
| C. Observation 是否保持只读？ | **是**（零写入，引用式） |
| D. Session 是否保持投影而非第二权威？ | **是**（只读、无持久化、无 transition） |
| E. Resource 是否因无真实冲突而保持 DEFER？ | **是**（正式结算见 §9） |
| F. 是否避免 Event Bus / Manager / 新 store？ | **是** |
| G. P23/P24/P25 所有权是否保持？ | **是** |
| H. 是否避免 P26-5..10？ | **是**（零引用） |
| I. 是否引入意外第二生命周期？ | **否**（finish/pause/resume 仍 NOT PRESENT） |
| J. P27 能否冻结？ | **能** |
## 3 Production Integration Inventory
| 集成 | PRODUCER | INPUT | OUTPUT | CANONICAL WRITE | SIDE EFFECT | P26 契约 | CONSUMER | PERSISTENCE | FAILURE SEMANTICS |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `activity.created` | `IB.activity`（`createActivity` 写入成功后） | 新建记录 | P26-1 event | **NO** | 本地回调广播 | P26-1 | **0** | 无 | 失败**不回滚** canonical |
| `activity.state` | `IB.activity`（`getObservation`） | activityId | P26-2 observation | **NO** | 无（纯读） | P26-2 | **0** | 无 | 失败 → `null`/unavailable，canonical 不变 |
| `IB.activity.getSession` | `IB.activity`（`getSession`） | activityId | P26-3 session 视图 | **NO** | 无（纯读） | P26-3 | **0** | 无 | 失败 → `null`，canonical 不变 |
## 4 Canonical Authority
`activities` store 仍**只**由 `IB.activity` 写（`dbPut/dbDelete('activities')`）。
唯一例外是 `assets/js/core.js` 的**既有**备份导入路径 `importAll`（`dbPut('activities', …)`，P27 之前就存在、非域 writer）。
Event / Observation / Session 投影**均未**产生第二个 writer（守卫 C1）。
## 5 Event Closure
- 顺序仍为 `canonical write 成功 → createDomainEvent`（源码断言 + P27-2 的 E7）。
- 事件失败**不回滚**（P27-2 E5：核心抛错 / `ok:false` / 核心缺失三种）。
- 生产事件词表**仍恰好** `activity.created`；**无** `activity.progressed` / `activity.finished` /
  `activity.deleted` / `session.created`（守卫 C2）。
## 6 Observation Closure
生产观察词表**仍恰好** `activity.state`（`source:'activity.state'`，`valueRef='activities/<id>'`），
只读、引用式、**无** canonical 快照复制、**无** subtitle/frame/page/chat 正文泄漏、
**不发** Event、**不产生** Feedback/Wake（守卫 C3；P27-3 O1–O13 仍全绿）。
P27-3 延后的候选与理由**仍然有效**：`current`（两个语义 + 读路径带写副作用）、
`subtitle`（无稳定 valueRef）、`frame`（需新持久化）、`page`/`progress`（已被同一 valueRef 覆盖）。
## 7 Session Closure
`getSession(activityId)` 仍是**只读投影**：`sessionId = activityId`、**无**持久 sessionId、
**无** session store、**无** Session Manager、**无** `transitionSession` 生产接线、
**无**指针依赖、**无**指针清理；**指针缺失 ≠ Session 结束**（守卫 C4；P27-4 S1–S21 仍全绿）。
## 8 Lifecycle Closure
P27-1 的决策**不复开**：`finish` / `pause` / `resume` 仍 **NOT PRESENT**；
`delete` 保持既有（无调用者）；Cinema close（`clearCurrent`）与 Co-read leave 仍是**离开 ≠ 结束**。
## 9 Resource Settlement
**正式结算：`P27-5 = DEFER / NOT REQUIRED FOR CURRENT PRODUCT`。**
证据（仅仓库事实）：Cinema 播放面是**单实例**且 `_loadMedia` 已用 `_destroyCurrent()` 串行化；
并发 Activity 记录**不是**资源冲突（指针只做选择）；Session 投影**不 claim**任何资源；
无 owner / lease / lock / priority / preemption 的真实需求。
⇒ 不实现 Resource；**P26-4 契约保留**，供未来出现真实冲突时使用。**不在 Closure 中实现。**
## 10 P26 Coverage
| 契约 | 结论 |
| --- | --- |
| P26-1 Domain Event | **PRODUCTION PROVEN** |
| P26-2 Observation | **PRODUCTION PROVEN** |
| P26-3 Session | **PRODUCTION PROVEN**（只读投影） |
| P26-4 Resource | **CONTRACT PROVEN / PRODUCTION NOT REQUIRED YET** |
这是可接受的 closure；**不把 P26-4 未被使用视为 P27 未完成**。
## 11 P26-5..10 Freeze
生产对 `feedback-core` / `feedback-consumption-core` / `wake-request-core` /
`wake-runtime-core` / `activation-intent-core` / `activation-runtime-core` 的引用 = **0**（守卫 C6）。
Activity Observation **不自动**变成 Feedback；Activity Session **不自动**变成 Wake；
`nudge` 仍是 Active Message 计划（非 Agent Wake）。
## 12 P23 Boundary
Activity 仍**不拥有** message splitting / sequence / delivery queue / typing / voice materialization；
`IB.activity.send` 仍进入既有 Chat/P23。P23 五核哈希未变（守卫 C11）。
## 13 P24 Boundary
**无** group participant selection / speaker order / `groupTurnId` / `groupOrder` / INTERJECT 所有权
（`group-runtime-core.js` 哈希未变）；multi-party Activity 仍 OUT OF SCOPE。
## 14 P25 Boundary
P27 **未**新增 Activity Capability / Autonomy / Agent Planner / Domain Authority 替代；
Intent / Capability / Plan / Autonomy / Authority / Execution 仍属 P25（`autonomy-core.js` 哈希未变）。
## 15 Persistence
**0** 新 store · **0** DB 版本变更 · **0** Event/Observation/Session/Resource 持久化；`DB_VER = 24`（守卫 C7）。
## 16 Production Core Loading
生产加载**恰好 3 个** P26 core：`domain-event-core.js` · `observation-core.js` · `session-core.js`。
**未加载**：`resource` / `feedback` / `feedback-consumption` / `wake-request` / `wake-runtime` /
`activation-intent` / `activation-runtime`（守卫 C9）。
## 17 Hash Coupling Audit
**问题（已确认结构性的）**：P27-2 / P27-3 / P27-4 每阶段都修改 `activity-runtime.js`，
导致**同一批 7 个守卫**反复重签**整文件哈希** —— 而被守护的不变量从未改变。
**受影响守卫**：`test_domain_event_core.js`(G6) · `test_observation_core.js`(G8) ·
`test_session_core.js`(G8) · `test_resource_core.js`(G8) · `test_feedback_core.js`(G8) ·
`test_p25_3e_activity_boundary_audit.js`(A14) · `test_p26_0_runtime_requirements.js`(R1/R15)。
## 18 Guard Refactor
分类（§18）：上述 7 处都是 **B 类**（只需要**语义不变量**，不需要整文件身份）——
它们真正守护的是：canonical writer 唯一 / 既有函数体未变 / 指针语义未变 / 既有事件机制未变 /
**未**接 Resource / **未**接 Feedback·Wake / 既有导出面保留。
**无 A 类**（没有任何守卫真正需要 `activity-runtime.js` 的整文件身份）。
## 19 Partition Freeze Strategy
**测试侧**修复（§23：不做生产重构）：新增 `tests/activity-partitions.js`，
按**语义分区**抽取函数体并逐分区哈希：
| 分区 | 函数 |
| --- | --- |
| `canonical_writer` | createActivity / getActivity / findActivity / listActivities / saveActivity / deleteActivity / setProgress |
| `pointer` | `_ptr*` / _usableFor / setCurrent / clearCurrent / resolveActivity |
| `context_read` | _chapterAt / buildActivityContext / getActivityContext |
| `chat_bridge` | send / openChat |
| `memory_nudge` | writeMemory / nudge |
| `event_mechanism` | _on / _off / _emit / mark / fav |
| `helpers` | _now / _esc / _fmt / _toast / _ensureThread |
**P27 适配器**（`getObservation` / `getSession` / `_emitActivityCreated`）**不在任何冻结分区内**。
机制 = 源码级函数抽取（花括号配对，**不用行号**）+ 逐分区 SHA-256；注释剥离后哈希
⇒ 注释编辑不触发重签，**代码变化一定触发**。
## 20 Closure Guard
新增 `tests/test_p27_closure_guard.js`（**12 checks**）：C1 canonical authority 唯一（含
`core.js` 仅导入路径的判定）· C2 唯一 `activity.created` · C3 唯一 `activity.state` ·
C4 `getSession` 只读投影（函数体内无 dbPut/localStorage/resolveActivity/transitionSession）·
C5 Resource 未集成 · C6 P26-5..10 未接线 · C7 `DB_VER=24` 且无新 store ·
C8 无 Bus/Manager/Store（HTML 注释先剥离）· C9 只加载 3 个 core · C10 Cinema/Co-read 保持 ·
C11 P23/P24/P25 边界 · **C12 哈希耦合已解决**。
**C12 内含变异测试**（在**字符串副本**上执行，不写仓库）：canonical writer 变化**必被发现**；
pointer 语义变化**必被发现**；**新增无关 getter** 与**改 P27 适配器** **不**触发既有分区变化。
## 21 Tests
Level-2 相关回归（§25）全部通过：P27 closure guard 12 · P27-4 20 · P27-3 13 · P27-2 7 ·
P27-1 11 · P27-0 10 · P26-1 43 · P26-2 33 · P26-3 25 · P26-4 23 · P26-5 20 ·
P26-0 18 · P26 closure 8 · P25-3E 16 · P25-3A 13 + 28 · Autonomy 41 ·
**Activity 浏览器 smoke PASS** · `test_frontend_structure.js` 仍 6 个既有 BOM 失败。
## 22 Baseline Failures
分类（§26）：`test_frontend_structure.js` 的 6 个 BOM 失败 = **B（pre-existing）**，
不因 P27 产生、本阶段**不修**。其它已知基线红（anthropic wire / runtime-convergence /
cache-audit / p11_2*）本阶段**未触碰**，分类同为 **B（pre-existing）**。
**无 A（P27 regression）、无 C/D/E。**
## 23 Worktree
| 文件 | 类型 |
| --- | --- |
| `tests/activity-partitions.js` | 新增（测试侧分区冻结工具） |
| `tests/test_p27_closure_guard.js` | 新增（closure 守卫） |
| `docs/P27-CLOSURE.md` | 新增（本文件） |
| `tests/test-all.js` | 注册 closure 守卫 |
| 7 个守卫（P26-1..5 / P26-0 / P25-3E） | **移除整文件哈希依赖，改用语义分区断言** |
**本阶段零 production 变更**：`activity-runtime.js` / `InternalBeyond.html` / Cinema / Co-read /
communication / core.js / P26 core 模块**均未修改**。
## 24 Commit Readiness
**COMMIT DEFERRED BY OWNERSHIP.** 混合所有权工作树；未 stage、未 commit。
## 25 Known Limitations
- P26-4 未在生产使用（有意），Resource 真实冲突仍不存在。
- P26-5..10 完全未接线（无 consumer）。
- Event / Observation / Session 三个读取模型**今天都没有消费者** —— 它们证明"契约在真实域里安全可用"。
- Session 投影的 `updatedAt` 是**记录级 last-write**（含进度写回），非生命周期迁移时刻；
  `endedAt` 不提供（无事实）。
- 分区哈希是**测试侧**锚点：若有人重构 `activity-runtime.js` 的函数边界（例如重命名既有函数），
  守卫会要求**有意重签**分区摘要 —— 这正是期望行为（不是漂移）。
## 26 Deferred / Future Items
| 项 | 状态 |
| --- | --- |
| P27-5 Resource Conflict Integration | **DEFER / NOT REQUIRED FOR CURRENT PRODUCT** |
| P26-5..10（Feedback / Consumption / Wake / Activation） | **未接线**（无 consumer） |
| P27-3 延后的观察（current / subtitle / frame） | **DEFER**（理由仍成立） |
| Participant / Multi-party Activity | **OUT OF SCOPE** |
| Cross-runtime Activity 通道 | **不存在**（仅既有 Active companion） |
| Event Bus | **NOT REQUIRED**（无多 producer/consumer/fanout/ordering/replay 证据） |
## 27 Next Phase Recommendation
**建议：Agent Runtime / 生产消费面**（在 P26 逻辑冻结与 P27 试点成功之上）。
- 今天三项接线的共同缺口是**没有消费者**：事件只被创建、观察只被读取、Session 只被投影。
  下一步的价值在于**真实的消费方**（例如：消费 `activity.state` 的活动上下文、消费
  `activity.created` 的统计/日志、消费 Session 视图的 UI 状态），而不是再造契约。
- **不建议**：新增 P26 层、实现 P27-5、造 Event Bus、把 ladder（P26-5..10）接线到 Activity。
- 若未来出现 Resource 真实冲突或 Feedback/Wake 需求：从**契约已冻结**的 P26-4 / P26-5..10 出发，
  按同样的"生产者—消费者—失败语义"纪律接入。
---
## 附录 · Final Questions（Q1–Q17）
1. **P26-1 是否在生产被证明？** **是**（`activity.created`，下游于 canonical 写入，失败不回滚）。
2. **P26-2 是否在生产被证明？** **是**（`activity.state`，只读、引用式、零写入）。
3. **P26-3 是否在生产被证明？** **是**（`getSession` 只读投影）。
4. **P26-4 现在需要生产集成吗？** **不需要**。
5. **P27-5 的正式结算？** **DEFER / NOT REQUIRED FOR CURRENT PRODUCT**。
6. **P27 是否创建了第二 canonical authority？** **没有**。
7. **P27 是否创建了第二生命周期？** **没有**。
8. **P27 是否引入持久化？** **没有**（DB_VER 24，零新 store）。
9. **P27 是否引入 Event Bus？** **没有**。
10. **P27 是否触碰 P26-5..10 生产？** **没有**（零引用）。
11. **Event / Observation / Session 是否仍语义独立？** **是**（三者互不自动触发）。
12. **HASH_COUPLING_DEBT 是真实存在的吗？** **是**（连续 3 个阶段 B 类重签）。
13. **是否在不削弱守卫的前提下解决？** **是**（分区 + 变异测试证明仍能发现真实变化）。
14. **现在新增一个无关安全 getter 会不会要重签无关守卫？** **不会**（变异测试证明）。
15. **P27 是否满足 closure 判据？** **是**（C1–C15 全部满足）。
16. **P27 能否逻辑冻结？** **能**（P27 LOGICALLY FROZEN）。
17. **下一阶段应该做什么？** **生产消费面（Agent Runtime / consumers）**，不是新契约层。
