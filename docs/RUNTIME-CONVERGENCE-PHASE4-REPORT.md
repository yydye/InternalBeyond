# InternalBeyond · Runtime Convergence Phase 4 报告

阶段：Runtime Convergence Phase 4（A. Diary 域收敛 + B. Memory Consolidation 迁移）。基准：Phase 3 完成后的工作区（`test-all --all` 90/90 全绿）。本次未提交 Git。

本阶段**未修改 Runtime 核心（`assets/js/agent-runtime.js` 零改动）**——所需契约字段（jsonMode / budget / executor{timeoutMs,disableTools} / usage / abort）在 Phase 1–3 已就位。

---

## 1. Diary 域是否已经 100% execute 收敛

**是。** Diary 域的两个模型调用点现在都经同一个 `_diaryModelCall`：

| 调用点 | 之前 | 现在 | telemetry kind |
|---|---|---|---|
| `generateDiaryEntry`（日记生成） | Phase 3 已迁 | `_diaryModelCall` | `generate` |
| `_diaryDailyPlanner`（今天是否值得写） | direct `callApiChat` | `_diaryModelCall`（本阶段） | `planner` |

证明：
- 测试用源码断言：`assets/js/active-diary/diary.js` 全文只有 **1 处** `callApiChat(`，且位于 `_diaryModelCall` 的 direct 回退内；接缝之外没有任何 `await callApiChat`。
- 测试用运行期断言：`_diaryTick()` 全链路中，planner 与 generation 各自产生 `consumer='diary'` 的 telemetry，`executor='runtime'`，`kind` 分别为 `planner` / `generate`，格式分别对应三个 provider。
- planner 与 generation 共用同一接缝：`window._diaryModelCall === IB.active.diary._diaryModelCall`（唯一函数）。
- abort 不进入 generation：`_diaryTick({signal:已中止})` → 新增日记 0 条、planner telemetry 0 条（预中止的 signal 不发起任何调用）。
- gate=false / runtime 不可用仍走**执行前** direct fallback（沿用 Phase 3 判定）；已发请求后不回落。

改动：`_diaryExecLog(cfg,rec,meta)` 增加 `meta.kind`（仅 telemetry 用，不进入执行器 opts）；`_diaryModelCall(cfg,messages,opts,meta)` 增加可选第 4 参；`_diaryDailyPlanner(character,opts)` / `_diaryTick(opts)` 增加可选 signal 透传。planner 的 prompt / 解析 / 判断 / 错误语义（内部 catch → `{shouldWrite:false}`）**逐行未改**。

---

## 2. Consolidation 新旧调用链

**迁移前**
```
_consolidationTick → consolidateCharacterMemory(cfg)
  → dbGetAll('memories') → 可见性过滤 → 真实时间排序 → prompt 组装          （未改）
  → callApiChat(cfg,[system,user],{maxTokens:800,timeoutMs:120000,wantMeta:false,
                                    jsonMode:true,_noWebSearch:true,disableTools:true})
  → 解析 → admission gate → refs/provenance 回退 → merge 或 quickCreateMemory
  → _markConsolidated（来源水位）→ 返回
```

**迁移后**
```
_consolidationTick → consolidateCharacterMemory(cfg, opts)                 （opts.signal 可选，新增）
  → 候选选择 / 可见性门 / 排序 / prompt                                     （未改）
  → _activeConsolidationModelCall(cfg, messages, {…, signal})
      ├─ runtime：runtime.resolveModel(cfg) → spec{streaming:false}
      │            IB.runtime.instance.execute(
      │              { spec, messages, jsonMode:true, budget:800,
      │                executor:{ timeoutMs:120000, disableTools:true } },
      │              { signal, onEvent })
      │              → ModelPort → callApiChat → _callApiChatOnce → _ibApiPost → provider
      └─ direct：callApiChat(cfg,messages,opts)（opts 原样；仅 gate=false / runtime 不可用）
  → 解析 / admission gate / provenance 回退 / merge 或 quickCreateMemory / 水位回写   （未改）
```

接缝与主动消息**共用**同一套 Active 域机制：`_activeRuntimeGate(overrideKey)`（本阶段加可选 override，默认行为不变）、`_activeRuntimeInstance()`、`_activeModelFormat()`（由 `_activeProactiveFormat` 更名，仅内部 2 处引用）、`IB.runtime.telemetry` 白名单。**没有第二套 migration framework。**

回滚：`window.runtimeConsolidationExecuteEnabled=false`（仅本域）或全局 `window.runtimeExecuteEnabled=false`。
telemetry：`consumer='memory_consolidation'`，`kind='consolidate'`。

---

## 3. direct / runtime contract

同一 `cfg` + 同一 `messages` + 同一 opts，两条路径逐字段比较（**不是**"最终 parse 成功"）：

**HTTP 请求体（`deepEqual`，三协议）**：OpenAI `response_format:{type:'json_object'}` / `max_tokens=800` / `messages[0].role='system'`；Anthropic 顶层 `system` 字符串、messages 无 system、无 `response_format`；Gemini `system_instruction` + `contents` + `generationConfig.responseMimeType='application/json'` + `maxOutputTokens=800`；三协议均无 `tools`。

**执行器选项（用 `callApiChat` 包裹捕获后 `deepEqual`）**：`{maxTokens:800, timeoutMs:120000, wantThinking:false, disableTools:true, jsonMode:true, _noWebSearch:true}` —— 两条路径完全一致。
`wantThinking` 本调用点未开启（direct 也不传）→ runtime 同样不传；`disableTools` / `timeoutMs` 经 `request.executor` 白名单，`jsonMode` 走契约顶层，`budget` 走 `request.budget`。
provider / format / model / endpoint / credential / identity：全部由 `resolveModel(cfg)` 派生（provider metadata 唯一真源仍是 `provider-directory.js`），请求体断言与 direct 相同。

Diary planner 同样做了 body + 执行器选项对照：`{maxTokens:300, timeoutMs:60000, wantThinking:false, disableTools:true, jsonMode:true, _noWebSearch:true}`，两路径逐字段一致。

---

## 4. Memory 副作用边界证明

**设计**：`_activeConsolidationModelCall` 只发请求、只返回 `{text,reasoning,usage,…}`；函数体内没有 `dbPut`/`dbGet`/语义记忆/水位/可见性写入。所有副作用仍在 `consolidateCharacterMemory` 的原代码行。

**测试**（真实 IndexedDB + `dbPut` 包裹计数）：

| 场景 | semantic 记忆 | 水位 `lastConsolidatedAt` | source visibility | memories 写入 |
|---|---|---|---|---|
| 成功（新建） | 恰好 1 条 | 推进（>0） | 不变 | semantic ×1 + 来源水位回写 |
| 成功（merge，新来源 + 相同内容） | 仍 1 条（不新建） | 推进 | 不变 | semantic ×1（同一条） |
| provider error（500） | 0 | 不推进（仍 null） | 不变（public） | **0 次 dbPut** |
| abort（非流式竞速中止） | 0 | 不推进 | 不变 | 0 |
| gate=false / runtime 不可用 | 1（业务照常） | 推进 | 不变 | 正常 |

**可见性 / provenance 不变**：`only` 来源 → 派生 semantic 仍是 `only` + `visibleTo=[角色]`（`isMemoryVisibleTo` 对所属角色 true、对其他角色 false）；`consolidatedFrom` 回退到**真实来源 id**（模型返回的 `ghost_source_id` 被拒绝）。
**历史修复不变**：同一 fixture 下 `_memRepairPlan()` 仍只提出 `semantic-broadened` + `diary-missing-visibility` 两类，apply 后 public→only，再次 plan 为 0（幂等）。

---

## 5. 全量测试结果

`node test-all.js --all`：**91 项全部通过，exit 0**（static 31 / service 16 / browser 44）。

| 项目 | 结果 |
|---|---|
| Phase 4 regression（`test_runtime_convergence_phase4.js`） | 20/20 通过（覆盖要求的 23 项 + 3 项锁定） |
| Phase 1 / 2 / 3 regressions | 14/14 · 18/18 · 16/16 通过 |
| Runtime Integration Audit | 10/10 通过 |
| Runtime opt-in smoke | 11/11 通过 |
| Memory consolidation tests | `test_memory_consolidation.js` 通过 |
| Memory repair tests | `test_memory_repair_dryrun.js` 通过 |
| localhost / file:// browser smoke | 各 5/5 通过，runtime 调用计数 0 |
| Chat / Group / Voice runtime 计数 | 0 / 0 / 0 |

Phase 4 用例与要求映射：1-3 planner 三协议／4 planner+generation 共用接缝／5 planner contract 等价／6 abort 不进入 generation／7 Diary 域无剩余 direct model call／8-10 consolidation 三协议／11 jsonMode+disableTools／12 budget+identity／13 usage／14 gate=false／15 runtime unavailable／16 provider error 无双调用／17 abort 无 retry／18 失败不写 semantic／19 失败不推进 watermark／20 成功 semantic 只写一次／21 visibility／22 provenance／23 historical repair；另锁 proactive / Moments / Diary 仍走 Runtime、Chat/Group/Voice 计数 0。

---

## 6. Runtime 新发现的契约缺陷

**无。** 本阶段 `assets/js/agent-runtime.js` 零改动：
- consolidation 所需的 `jsonMode`（契约顶层）、`budget`、`executor.timeoutMs` / `executor.disableTools`、`usage`、`abort` 均已在既有契约内；
- 未扩 telemetry schema（复用 `kind` / `characterId` 等既有白名单字段）；
- 未改 `resolveModel()` 的语义——**没有引入任何自动选模型/路由**；`resolveModel` 仍只把 cfg 的 provider/model/endpoint 映射成 ModelSpec，用户/角色绑定不变。

---

## 7. 当前还有哪些 direct consumer

**已迁移（走 Runtime execute）**：主动消息（Active）、Moments（发帖/评论/回复）、Diary（planner + generation）、Memory Consolidation。

**仍为 direct 的生产模型调用（按耦合度排序）**：

| 位置 | 用途 | 形态 | 迁移难度 |
|---|---|---|---|
| `role-letters.js:170`（`_rlCall`） | 角色私信：主动写信 + 回信（2 个 consumer 共用） | 单次、非流式、jsonMode、disableTools | **低**（一行接缝） |
| `active-diary.js:1015` | Understanding / Thread 生成 | 单次、非流式、jsonMode（700） | **低** |
| `active-diary/active-plans.js:281` | AI 计划生成 | 单次、非流式、jsonMode（600） | 低-中（计划域） |
| `active-diary/active-plans.js:409` | 计划评估 | 单次、非流式、jsonMode（300） | 低-中 |
| `app-store.js:128` | 应用目录生成 | 单次、非流式、jsonMode:false（600） | 低（但 jsonMode 关闭，需确认契约） |
| `game/game_story.js:481`、`game_tea.js:1000`、`game_tarot.js:561/641` | 游戏内对话/塔罗/茶室 | 可选流式（`_isStreamEnabled`），8192 tokens 或 wantMeta | 中（需流式契约） |
| `workspace.js:783` | 工作区多轮续写 | `autoContinue:true`（多轮循环） | 高（当前 ModelPort 强制单次） |
| `communication.js:1705/1716/2114/2832` | Chat / Group | 流式优先 + 工具 + 多轮 + 群成员 | 高（需流式/工具/上下文契约） |

**接缝内的 direct 回退**（按设计保留，不算"未迁移"）：`active-diary.js:535`（consolidation）、`diary.js:224`、`moments.js:91`、`active-diary.js` 主动消息接缝。

---

## 8. 是否应该停止 execute-only migration 并进入 Context Convergence

**建议：是——在 Phase 4 之后停止"逐个 consumer 迁移"，转入 Context Convergence。**

依据：
1. **边际收益递减**：剩下的 direct consumer 里，最容易的三个（role-letters、Understanding/Thread、计划生成/评估）都是**后台低频**路径，迁移它们不改变任何用户可感知行为，也不解锁新的能力；每个仍需要"接缝 + 回归测试 + 报告"的固定成本。
2. **下一个大目标被 Context 阻塞**：真正的价值在 Chat/Group/Voice（每轮对话）。它们不仅要流式/工具/多轮契约，**更依赖上下文收敛**——P2-03（单聊一轮内 Memory/Understanding/Thread/Moments 被读两次、Astra 压缩结果追加而非替换）会随迁移一起被搬进 Runtime，先迁等于固化缺陷。
3. **P2-03 是现存缺陷而非重构**：`getMemoryContext` 有激活计数副作用，重复调用会放大记忆激活；这是可测量的行为偏差，值得优先修。
4. **execute 契约已稳定**：三阶段零契约缺陷（本阶段 Runtime 核心零改动），说明 execute 层已收敛完成；继续在同一层做小消费者迁移的信息增量很低。

建议的 Context Convergence 分期（保持与 execute 阶段同样的"小步 + 可回滚 + 回归"纪律）：
- **C1（先做）**：修 P2-03 重复检索——把 `buildChatContext` 已读到的 Memory/Understanding/Thread/Moments 块通过 `opts.*Ctx` 传给 Middle Brain pipeline（该接缝已存在），并明确"追加 vs 替换"语义；补一个"一轮只读一次 + 不重复注入"的回归测试。
- **C2**：定义 canonical Context 形状（`P2-CONTEXT-CONVERGENCE-AUDIT.md` §2.4 的字段清单）并让 4 个生产者映射到它；此时 `runtime.loadContext` / `composeMessages` 才具备"可替换"的资格。
- **C3**：只有 C1/C2 落地后，才评估 Chat 的 execute 迁移（并同时设计流式/工具契约）。

**不建议**在 C1 之前继续迁移 `workspace.js`（多轮）或 Chat/Group（流式+工具）——它们会迫使 Runtime 立刻扩张成"半套执行器"，违背"execute-only、单次、非流式"的既有边界。

**可以顺手做的低风险项（不单独开阶段）**：把 `role-letters.js:_rlCall` 与 `active-diary.js:1015`（Understanding/Thread）按 Phase 1–4 的模板一并迁掉——每个约 40 行接缝 + 1 个回归用例，可作为 Context Convergence 开始前的收尾。
