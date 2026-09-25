# P25-3B · Diary Capability Integration

状态：**Diary Capability INTEGRATED**。Diary 的**写权限**第一次离开 scheduler / model /
executor，成为独立权威；编排层与 legacy 生产链共用**同一个** Diary Authority。
P25-3A 的编排契约（registry / core / moments adapter）**零修改**。

实现位置：

- `assets/js/diary-authority.js`（唯一写权限：candidate → decision → 仅 ALLOW 才执行）
- `assets/js/agent-orchestration-diary-adapter.js`（`diary.write` descriptor + authority route + verifier binding）
- `assets/js/active-diary/diary.js`（生产收敛：`_diaryRunWrite` / `_diaryWriteCanonical` 接缝）
- `InternalBeyond.html`（加载 `diary-authority.js`；**不**加载编排 adapter —— 编排层仍是 foundation-only）
- 测试：`tests/test_diary_authority.js`（D1–D20）、
  `tests/test_agent_orchestration_diary_adapter.js`（OD1–OD20 + PC1–PC15）

---

## 1. Scope

把既有的 Diary 生成链：

```
scheduler / trigger → model → model output → dbPut(DIARY_STORE) →（可选）_diaryWriteMemory
```

收敛为：

```
Diary Trigger → Diary Candidate → **Diary Authority** → ALLOW → Diary Executor
              → Canonical Diary Writer → Verifier
```

并把 `diary.write` 登记进 P25-3A Capability Registry。
**本阶段不引入**：新 schema、DB migration、新持久队列、新 scheduler、新后台进程、
Memory 接入、Middle Brain 接入、Group Runtime 修改、P23 / P24 修改、Moments 重构。

## 2. Phase 0 audit（只读）

| 问题 | 结论（仓库事实） |
| --- | --- |
| A. scheduler 在哪 | `assets/js/active-diary.js` 的 `_activeTick` → `await _diaryTick()`（浏览器；无 Node 版本） |
| B. trigger 闭集 | `weekly` / `daily_plan` / `first_chat` / `return_after_gap` / `manual` / `wish` |
| C. `generateDiaryEntry` 的 caller | `_diaryTick`（weekly / daily_plan）、`_diaryMaybeEvent`（first_chat / return_after_gap）、`_diaryWriteNow`（manual）、`_diaryTodayWish`（wish） |
| D. 模型调用点 | `_diaryModelCall`（唯一接缝：runtime.execute，不可用时回落 `callApiChat`）；planner 与 generation 共用 |
| E. 模型返回结构 | JSON（`title/content/mood/diaryType/importance/relatedMemoryIds/memoryCandidate`），失败时 `标题:/正文:/心情:` 纯文本兜底 |
| F. 谁决定 write / skip | **改动前**：模型输出（解析成功即落库）；planner 只决定 `daily_plan` 是否触发；prefs 只决定 tick 是否运行。**改动后**：Diary Authority |
| G. `dbPut(DIARY_STORE)` 调用点 | 2 处（首写 + 追加 memory id），均在 `generateDiaryEntry`；P25-3B 收敛为一个 `_diaryWriteCanonical` |
| H. `dbDelete(DIARY_STORE)` 调用点 | 1 处（`_diaryDelete`，用户删除按钮） |
| I. update / edit Diary | 不存在（唯一"修改"是同一对象追加 `relatedMemoryIds`） |
| J. manual Diary create | 不存在"用户直接写日记"；UI 的"让她写一篇日记"是**请求角色写** |
| K. 用户明确要求角色写 | 存在：`_diaryWriteNow`（manual）/ `_diaryTodayWish`（wish） |
| L. AI autonomous Diary | 存在：`weekly` / `daily_plan` / `first_chat` / `return_after_gap` |
| M. browser / Node 双 runtime | **只有 browser**（Diary 无 Node/companion runtime） |
| N. `_diaryWriteMemory` | 由 `generateDiaryEntry` 在 canonical write **之后**调用；写 `memories`（`visibility:'only'`）；失败返回 null；**不属于** canonical Diary transaction |
| O. 图片 / 附件 / TTS / 通知 | 无（Diary 没有交付侧副作用） |
| P. identity | `_diaryDefaults`：`diary_<Date.now(36)>_<Math.random(36)>`，由 **domain 持有** |
| Q. duplicate / idempotency | 有文本相似度去重（`DIARY_SIMILARITY_LIMIT=0.75`，命中即在 attempt 0 重写一次）；无持久幂等键 |
| R. cooldown / frequency | 有：localStorage 水位线 `wk_<id>`（周）/ `dl_<id>`（日），**先占位再生成** |
| S. 角色开关 / preferences | 有：`ib_diary_prefs_v1`（enabled / weeklyEnabled / weeklyDay / weeklyTime / dailyPlannerEnabled / eventEnabled） |
| T. 删除 / 编辑权限 | 用户可删除（`_diaryDelete`）；无角色侧删除/编辑；删除当前无 authority（既有 debt，本阶段**不改**） |

## 3. Existing Diary architecture（改动后）

```
_diaryTick（active-diary.js 调用）
  ├─ weekly  ：水位线 wk_<id> 先占位 → generateDiaryEntry(trigger:'weekly')
  └─ daily   ：水位线 dl_<id> 先占位 → _diaryDailyPlanner → shouldWrite ? generateDiaryEntry(trigger:'daily_plan')
_diaryMaybeEvent（fire-and-forget, 800ms）→ generateDiaryEntry(trigger:'first_chat' | 'return_after_gap')
_diaryWriteNow / _diaryTodayWish（UI）→ generateDiaryEntry(trigger:'manual' | 'wish')

generateDiaryEntry(characterId, opts)
  cfg（apiConfigs/archivedConfigs + _ibApiReady）        ← 未改
  _diaryContext → buildDiaryPrompt → _diaryModelCall（≤2 次：解析失败/去重重写）  ← 未改
  _diaryParseOutput → _diaryDuplicateCheck                ← 未改（仍在裁决之前）
  _diaryDefaults（entry.id 由 domain 生成）                ← 未改
  ── P25-3B 接缝 ──
  _diaryRunWrite(candidate, facts, executor)
      └─ Diary Authority：decision=allow ⇒ executor
            └─ _diaryWriteCanonical(entry)  → dbPut(DIARY_STORE, entry)      ← 唯一写入口
  canonical 成功之后：_diaryWriteMemory →（有 memory 时）追加 relatedMemoryIds 再写一次
  UI：currentPage==='diary' ⇒ _diaryRenderVault()
```

## 4. Trigger classification

| 分类（§6） | 是否存在 | 实例 |
| --- | --- | --- |
| MANUAL_USER_DIARY（用户直接写日记） | **NOT PRESENT** | Diary 里没有"用户署名作者"的写入面 |
| USER_REQUESTED_CHARACTER_DIARY | PRESENT | `manual`（"让她写一篇日记"）、`wish`（"今天想写些什么？"） |
| AUTONOMOUS_DIARY | PRESENT | `weekly`、`daily_plan`、`first_chat`、`return_after_gap` |
| SYSTEM_DIARY | PRESENT | 与 AUTONOMOUS_DIARY 同一条路径（无独立系统主体） |
| MIGRATION | **NOT PRESENT** | Diary 无 migration 入口 |

## 5. `diary.write` semantics

`diary.write` = **"请求角色生成并写入一篇 Diary entry"**（domain capability），
**不是** raw storage primitive（不是"把一段文本塞进 Diary DB"）。
因此 adapter 不接收/不传递日记正文，executor 只转交既有 domain 入口。

## 6. Candidate contract

```
{
  candidateId,          // 'dca_' + stableToken(actorId|source|trigger|triggerRef|diaryType)
  actorId,              // = apiConfigs/archivedConfigs 的 id（不是昵称）
  source,               // 'schedule' | 'character' | 'user'
  trigger,              // 'weekly' | 'daily_plan' | 'first_chat' | 'return_after_gap' | 'manual' | 'wish'
  triggerRef,           // 可选：调度/事件引用（如 'wk_<id>'）
  diaryType,            // 'daily' | 'weekly' | 'event' | 'emotion'（与 domain 闭集一致）
  contextRef            // 可选：上下文引用（非正文）
}
```

## 7. Identity

- Diary entry id **仍由 domain 持有**（`_diaryDefaults` 的 `diary_<time36>_<rand>`，未改）；
  本阶段**不重新发明** Diary identity（§19）。
- `candidateId` 是本阶段新增的**纯派生**身份，只用于 authority / 审计 / 幂等键透传。
  它由 `chat-core.stableToken` 派生 ⇒ 确定性、可重放，且不含 `Date.now` / `Math.random`。
- 编排层只透传 `idempotencyKey`（= candidateId）；domain 仍是唯一身份持有者。

## 8. Authority contract

`assets/js/diary-authority.js`（纯 UMD，浏览器 + Node 双挂载 `IBDiaryAuthority`）：

| 导出 | 作用 |
| --- | --- |
| `buildDiaryCandidate(input)` | 校验并构造 candidate（返回 `{ok, candidate, errors}`） |
| `sourceOfTrigger(trigger)` | trigger → source 的唯一映射（未知 trigger ⇒ `''`） |
| `decideDiaryWrite(candidate, facts)` | 纯决策：`{decision, reason}` |
| `runDiaryWrite(candidate, facts, executor)` | 唯一入口：DENY ⇒ 不调用 executor；ALLOW ⇒ 执行恰好一次 |
| `verifyDiaryWrite(result, reader)` | 只验证 canonical 行存在（reader 注入），不补写、不 retry |

## 9. Decision semantics

闭集：`allow` / `deny`（**无 DEFER** —— Diary 的"稍后"语义已经由水位线承担，
写动作本身没有延迟语义；不因为 Orchestrator 支持 deferred 就机械加入）。

判定顺序（全部 fail closed）：

```
candidate 非法            → deny / invalid-candidate
actorKnown !== true       → deny / unknown-actor
cancelled === true        → deny / cancelled
enabled   !== true        → deny / disabled
hasContent !== true       → deny / empty-content
否则                       → allow / allowed
```

executor 缺席 ⇒ `deny / no-executor`；authority 模块缺席 ⇒ domain 侧 fail closed
（`_diaryRunWrite` 返回 `deny / authority-missing`），**绝不**退回旧直写。

## 10. Authority facts

只读自真实状态的四项（不发明情绪分数 / 亲密度阈值 / relevance score）：

| fact | 来源 |
| --- | --- |
| `actorKnown` | `generateDiaryEntry` 内 `cfg` 是否解析成功 |
| `enabled` | `_diaryPrefs().enabled === true` |
| `hasContent` | `entry.content` 去空白后非空 |
| `cancelled` | `opts.cancelled === true`（orchestration 可传；legacy 路径不传） |

## 11. Model boundary

模型只产**内容与推荐**（`parsed`：title/content/mood/diaryType/importance/memoryCandidate）；
`parsed` **不进入** candidate，也不参与 decision。已由测试证明：
把 `modelWantsWrite` / `confidence` / `draft` 塞进 candidate 不改变结论（D5），
并且把 authority 换成"永远 DENY"后模型仍被调用、仍然零落库（PC3）。

## 12. Scheduler boundary

scheduler 只回答 **when**：水位线（`wk_` / `dl_`）先占位、`weeklyDay` / `weeklyTime` 判定、
`dailyPlannerEnabled` 开关 —— 全部**未改**（PC7/PC8）。
`_diaryTick` 体内不含 `dbPut` / `_diaryWriteCanonical` / `_diaryRunWrite` / `DIARY_STORE`
（PC2）：scheduler 不能直达 writer。

## 13. Executor

executor 只做**已授权**的写入（`async () => await _diaryWriteCanonical(entry)`），
不重新判断 enabled / duplicate / policy，也不调用第二套 authority（§16）。
执行失败 ⇒ `ok:false, decision:'allow', executed:true`（**不是** DENY，D9/PC6）。

## 14. Canonical writer

`_diaryWriteCanonical(entry, options)` 是本域唯一 `diary_entries` 写入口
（首写与追加 memory id 都经它）；改动前散在 `generateDiaryEntry` 的两处
`dbPut(DIARY_STORE, entry)` 已收敛。

## 15. Memory side-effect boundary

`_diaryWriteMemory` 属于 **B. Diary 写成功之后的 secondary side effect**，不是 canonical
transaction 的一部分：

```
Diary canonical write → success →（可选）Memory side effect
```

- Memory 失败/跳过**不得**把已经写成功的 Diary 伪装成失败（PC14：`dbPut('memories')` 抛错时
  `generateDiaryEntry` 仍 `ok:true`、`memory:null`、Diary 行存在）；
- 调用顺序在源码与运行时都被钉住（PC13：`diary_entries → memories → diary_entries`）；
- 本阶段**不修改** Memory Authority、**不**把 Memory 注册成 capability、**不新增** Memory 写入路径。

## 16. Duplicate

既有去重（文本相似度 ≥ 0.75 ⇒ 重写一次）**未改**，且**仍在裁决之前**运行
（D18 钉住位置）：否则会多出一次模型调用或少一次重写。
Authority **不引入**第二套 duplicate store：Diary 没有持久幂等键，
本阶段也不新增（candidateId 只作审计/幂等键透传，不落盘）。

## 17. Frequency

水位线语义未改（PC8：同一天（`dl_<id>`）只写一次；planner 只调用一次）。
Authority 不读时钟、不持有 interval（D19：模块内零 `setInterval` / `setTimeout` /
`watermark` 概念）。planner 的 `shouldWrite` 语义（`importance >= 6`）未改。

## 18. Registry descriptor

```
{
  id: 'diary.write',
  domain: 'diary',
  kind: 'write',
  description: '请求角色生成并写入一篇 Diary entry（经 Diary Authority 裁决）',
  sideEffect: 'local',
  authorityType: 'domain',
  binding: 'diary.write'
}
```

字段遵守 P25-3A frozen descriptor（P25-3A registry contract **未修改**；
不含凭据 / 函数 / provider 字段，descriptor 深冻结）。

## 19. Adapter

`assets/js/agent-orchestration-diary-adapter.js`：

| 能力 | 说明 |
| --- | --- |
| `registerDiaryCapabilities(registry)` | 只登记 descriptor |
| `createDiaryOrchestrationAdapter(deps)` | `deps = {authority, domain, reader}`（全部注入） |
| `invokeAuthority(descriptor, step)` | 调**真实** Diary Authority；ALLOW 时把"已授权意图"记进 runtime-only envelope |
| `resolveExecutor(descriptor)` | 只转交既有 domain 写入口；同一步第二次执行被拒（`executor-called-twice`） |
| `idempotencyKeyFor` | 透传 domain 身份（candidateId 或调用方给的 key） |
| `verify(executionResult)` | 绑定 `verifyDiaryWrite`（async，因为 canonical 读是异步的） |
| `describeDiaryAvailability(env)` | 只回答基础设施可用性（见 §23） |

Adapter **零** DB / DOM / fetch / provider / 模型（OD4/OD5 断言）。

## 20. Production convergence

legacy 生产链本身也经 Diary Authority（§25：不允许"只有 Orchestrator 安全"）：

```
（改动前）scheduler → model → writer
（改动后）scheduler → model → **Diary Authority** → ALLOW → _diaryWriteCanonical
```

PC1 在真实 `diary.js`（沙箱）上证明：`_diaryTick` 触发的生成确实先经
`IBDiaryAuthority.runDiaryWrite` 且 decision 为 `allow` 才落库。

## 21. Double-authority analysis

P25-3A 的 Moments adapter 出现过"编排层预检查 + domain executor 内再次裁决"，
本阶段审计后的结论：

1. **不实现** authorized-execution-envelope bypass。Diary 的 domain 写入口
   （`generateDiaryEntry`）同时服务 UI、scheduler、事件三条 legacy 链路 ——
   一个"只有编排层能打开"的旁路写面反而会制造**第二套写权威**（禁止）。
2. 编排层预检查与 domain 内裁决调用的是**同一个** authority、**同一份** facts：
   两次都是 fail-closed，第二次不可能放宽第一次的结论；状态在执行中途变化时
   第二次 DENY 是**正确**结果，不是"重复裁决 bug"。
3. 因此两次裁决是"同权威的冗余守卫"，不构成双权威。PC15 钉住这一点：
   编排路径上一次 step = authority 2 次调用（orchestration + domain）、
   domain 写入 1 次、Diary 行 1 条、verifier 通过。
4.（不实现 envelope 的）代价：多一次纯函数裁决（无 IO、无副作用、微秒级）。

## 22. Verifier

`verifyDiaryWrite(result, reader)` 是 P25-3A 之后**第一个真正实现的 verifier**：

| 情况 | 结果 |
| --- | --- |
| 未完成 / `ok !== true` | `{verified:false, errorCode:'not-completed'}` |
| 无可验证 entry id | `errorCode:'missing-entry-id'` |
| canonical 行不存在 | `errorCode:'canonical-entry-missing'` |
| canonical 行归属不符 | `errorCode:'identity-mismatch'` |
| 存在且归属正确 | `{verified:true, entryId}` |

Verifier 只**读**（reader 注入）：不补写、不 retry、不创建第二篇（OD11/OD12）。

## 23. Availability

`describeDiaryAvailability({diaryModuleLoaded, writerAvailable, degraded})`
→ `available` / `unavailable` / `degraded`。
availability **不是** permission：`enabled=false`、未知角色、空内容一律由 Diary
Authority **DENY**（PC5 断言 `deny / disabled` 且零落库），**不**伪装成
"capability unavailable"。

## 24. Cancellation

- 编排层：沿用 P25-3A contract（`isCancelled()` ⇒ 后续 step `denied / cancelled`）；
  执行前的取消**不写**（OD15），已完成的写入**不回滚**（OD16，无通用 rollback）。
- 域内：`_diaryRunWrite` 的 facts 支持 `cancelled` ⇒ `deny / cancelled`，
  executor 不被调用；已写成功的 Diary 不会被撤销。
- Memory side effect：若 Diary 已写成功后才取消，按真实事务边界处理 ——
  Diary 保留、Memory 是否发生取决于取消时点（不做跨域 rollback）。

## 25. No-CoT

candidate / facts / authority 结果 / adapter 结果 / verifier 结果中**没有**
thinking / analysis / rationale / scratchpad / chain_of_thought 字段（D16/OD20）。
Diary **正文**不是 CoT：正文不进 candidate、不被扫描剔除（§32）。

## 26. Secret boundary

- candidate 全对象经 `voice-message-core.findSecret` 扫描：命中凭据形态 ⇒
  `secret-in-candidate`（D15）；
- authority / adapter 结果不含 `apiKey` / `authorization` / `credential` / provider 配置；
- registry descriptor 禁止凭据字段（P25-3A 既有 contract，未改）；
- 模型调用仍走既有 provider boundary（`_diaryModelCall`），本阶段未触碰。

## 27. Frozen guards

P25-3B 结束时逐字节未变：

| 文件 | SHA-256 |
| --- | --- |
| `assets/js/autonomy-core.js` | `FE1011F1…9F2956F8` |
| `assets/js/communication.js` | `DEB568A2…AC29184F` |
| `assets/js/group-runtime-core.js` | `6F30FDE9…067B35E8` |
| `assets/js/delivery-planner.js` | `15E7DBD0…E887308C` |
| `assets/js/delivery-runtime.js` | `82BC57D7…F7F46802` |
| `assets/js/delivery-sequence-core.js` | `5AE59648…FEB7EB35` |
| `assets/js/multimodal-delivery-policy.js` | `B7AFDFA6…ABC8B370` |
| `assets/js/voice-message-core.js` | `06907AA2…DEDDB258` |
| `assets/js/moments.js` | `E23697DE…B82CEE31` |
| `assets/js/moments-autonomy.js` | `A4CEE6DA…C843CD1A` |
| `assets/js/moments-mutation-authority.js` | `1FBB1E12…2FB5A056` |
| `assets/js/moments-semantic-core.js` | `FECCDA5E…B72DA7B7` |
| `services/home-node/moments-store.js` | `F7852B44…97F5F6D2` |
| `assets/js/agent-capability-registry.js` | `78AE9DFE…273BF7A2` |
| `assets/js/agent-orchestration-core.js` | `BA4A3DFA…AC204F79` |
| `assets/js/agent-orchestration-moments-adapter.js` | `DA2506B9…EC6BD466` |

改动（P25-3B）：

| 文件 | SHA-256 | 性质 |
| --- | --- | --- |
| `assets/js/diary-authority.js` | `BBB7EC88…C95E73A9` | 新增（纯权威） |
| `assets/js/agent-orchestration-diary-adapter.js` | `7D98217B…34AA9805` | 新增（adapter，未加载进页面） |
| `assets/js/active-diary/diary.js` | `86C355D6…702B16DA` | 收敛（唯一写入口 + authority 接缝） |
| `InternalBeyond.html` | `A3D0729E…884D1F06` | 加载 `diary-authority.js` |
| `tests/test-all.js` | `4ACFE64D…933978E5` | 注册两个新套件 |

`DB_VER` / Moments schema / `_diaryWriteMemory` 的 Memory 语义均未改变。

## 28. Tests

| 套件 | 覆盖 |
| --- | --- |
| `tests/test_diary_authority.js` | D1–D20：candidate / decision / facts / 执行力 / verifier / 纯度（DB·DOM·模型·Memory·MB）/ 秘密 / CoT / 确定性身份 / duplicate / frequency / 既有导出面 |
| `tests/test_agent_orchestration_diary_adapter.js` | OD1–OD20（注册 / descriptor / 路由 / Plan != Permission / DENY 零执行 / verifier / 幂等透传 / 取消 / 不回滚 / 不 retry / 无 Memory·MB / 无秘密·CoT）+ PC1–PC15（真实 `diary.js` 生产收敛） |

PC 段在 vm 沙箱里加载**真实** `chat-core` / `voice-message-core` / `diary-authority` /
`active-diary/diary.js`，用内存 store 桩替代 IndexedDB；不触网、不写真实数据库。

## 29. Known limitations

1. **Diary 只在浏览器**：Node/companion 没有 Diary runtime，因此本阶段没有双 runtime 收敛问题。
2. **raw manual DB write 不存在**：UI 的"写日记"始终是"请求角色写"，没有用户署名直写路径。
3. **删除仍无 authority**：`_diaryDelete` 只有用户确认 + `dbDelete`（既有 debt，
   P25-3B 未扩大范围）；因此 `diary.delete` 未登记为 capability。
4. **`_diaryHhmm('00:00')` 的既有折叠**：hour 为 0 时 `parseInt(...)||22` 会折叠成 22:00
   （既有实现细节，P25-3B 未改，测试因此用每日 planner 路径验证"到期"）。
5. **`enabled=false` 时手动请求也会 DENY**：这是 §30 要求的语义
   （权限问题由 authority 回答，而不是伪装成技术不可用）；UI 会显示失败提示。
6. **编排 adapter 未加载进页面**：编排层仍是 foundation-only；
   `diary.write` 只被 descriptor/测试使用，生产触发仍走 domain 路径。
7. **verifier 绑定是 async**：P25-3A 的 `verifyStepResult` 是同步 contract，
   Diary 的 canonical 读（IndexedDB）是异步的 ⇒ adapter 暴露 `async verify()`，
   调用方 await；**未修改 Foundation contract**。
8. **channels 有限**：`diary.write` 当前只有 `write` 一种语义，没有 read/delete 能力登记。

## 30. Deferred work

- `diary.delete` / `diary.read` 能力登记与删除 authority（需要独立的删除权限设计）。
- Diary 的正式幂等键（当前 candidateId 只透传，不落盘）。
- Active Message / Role Letters / Activity / Economy / Memory / Middle Brain 能力接入
  （P25-3C+，本阶段明确不做）。
- Orchestrator 真正驱动 Diary（当前编排层不持有生产触发）。
