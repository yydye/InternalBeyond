# InternalBeyond · Runtime Convergence Phase 3 报告

阶段：Runtime Convergence Phase 3（第三个生产执行接缝）。基准：Phase 2 完成后的工作区（`test-all --all` 89/89 全绿）。本次未提交 Git。

迁移对象：`assets/js/active-diary/diary.js` → 日记生成的模型执行接缝（新 `_diaryModelCall`）。
迁移性质：**只收敛最终模型 execute**；Diary 的触发、context、prompt、解析、校验、retry、fallback、落库、`_diaryWriteMemory`、visibility、scheduler 全部未改。

---

## 1. 修改文件

| 文件 | 变化 |
|---|---|
| `assets/js/active-diary/diary.js` | 新增统一执行接缝 `_diaryModelCall` + `_diaryRuntimeGate` / `_diaryRuntimeInstance` / `_diaryFormat` / `_diaryExecLog`；`generateDiaryEntry` 的模型调用改为经该接缝（其余代码行未动）；双挂载 `window._diaryModelCall` + `IB.active.diary._diaryModelCall` |
| `test_runtime_convergence_diary.js` | 新增 Phase 3 convergence regression（16 用例，覆盖要求的 23 项） |
| `test-all.js` | 登记新测试（browser 组） |
| `docs/RUNTIME-CONVERGENCE-PHASE3-REPORT.md` | 本报告 |

未改动：`_diaryTick`、`_diaryDailyPlanner`、`_diaryMaybeEvent`、`_diaryContext`、`buildDiaryPrompt`、`_diaryParseOutput`、`_diaryDuplicateCheck`、`_diaryDefaults`、`dbPut(DIARY_STORE)`、`_diaryWriteMemory`、`_diaryPrefs`/水位线、UI 渲染。

**明确未迁移（登记）**：`diary.js:328` 的 `_diaryDailyPlanner`（"今天是否值得写日记"的判定）仍走 direct。它不属于"日记生成"边界（不产出日记、只决定是否触发），且错误语义不同（内部吞错返回 `shouldWrite:false`）。如需一并收敛，是一处 2 行的 `_diaryModelCall` 调用替换，建议单独小项处理，不在本阶段顺手改。

---

## 2. Diary 新旧执行链

**迁移前**
```
_diaryTick / _diaryWriteNow / _diaryMaybeEvent
  → generateDiaryEntry(characterId,opts)
      → _diaryContext → buildDiaryPrompt                     （未改）
      → callApiChat(cfg,built.messages,{maxTokens:2000,timeoutMs:120000,wantMeta:false,
                                        jsonMode:true,_noWebSearch:true,disableTools:true})
      → _diaryParseOutput → _diaryDuplicateCheck → dbPut(DIARY_STORE) → _diaryWriteMemory
```

**迁移后**
```
_diaryTick / _diaryWriteNow / _diaryMaybeEvent
  → generateDiaryEntry(characterId,opts)                     （未改）
      → _diaryContext → buildDiaryPrompt                     （未改）
      → _diaryModelCall(cfg,built.messages,{…,signal:opts.signal})   ← 唯一执行接缝
          ├─ runtime：runtime.resolveModel(cfg) → spec{streaming:false}
          │            IB.runtime.instance.execute(
          │              { spec, messages, jsonMode:true, budget:2000,
          │                executor:{ timeoutMs:120000, disableTools:true } },
          │              { signal, onEvent })
          │              → ModelPort → callApiChat → _callApiChatOnce → _ibApiPost → provider
          └─ direct：callApiChat(cfg,messages,opts)（opts 原样，不追加任何字段）
      → _diaryParseOutput → _diaryDuplicateCheck → dbPut(DIARY_STORE) → _diaryWriteMemory   （未改）
```

回滚/降级（全部在接缝内）：
| 条件 | 行为 | fallbackReason |
|---|---|---|
| `window.runtimeDiaryExecuteEnabled===false`（未设时看全局 `runtimeExecuteEnabled`） | direct | `gate_disabled` |
| `IB.runtime.instance.execute` 不可用 | direct | `runtime_unavailable` |
| `execute` 抛异常 / 返回 error / 中止 | 不回落，交给原 retry/错误链 | `runtime_execute_threw`（仅抛异常时） |

---

## 3. Runtime / direct contract comparison

对同一 `cfg` + 同一 `messages` + 同一 opts，分别走 runtime 与 direct，**逐字段比较**（不是"最终 parse 成功"）：

**HTTP 请求体**（`deepEqual`，三协议各自通过）：
| 维度 | OpenAI | Anthropic | Gemini |
|---|---|---|---|
| body runtime vs direct | 逐字段相同 | 逐字段相同 | 逐字段相同 |
| jsonMode 落点 | `response_format:{type:'json_object'}` | 无 `response_format`（与 direct 一致） | `generationConfig.responseMimeType='application/json'` |
| identity/system 位置 | `messages[0].role='system'` | 顶层 `system` 字符串，messages 无 system | `system_instruction.parts[0].text` |
| budget | `max_tokens=2000` | `max_tokens=2000` | `generationConfig.maxOutputTokens=2000` |
| tools | 无 `tools` | 无 | 无 |
| model | body.model | body.model | URL `{model}` |
| 返回原文 | 相同 | 相同 | 相同 |

**执行器选项**（HTTP body 里看不到的部分，用 `callApiChat` 包裹捕获后 `deepEqual`）：
两条路径均为 `{maxTokens:2000, timeoutMs:120000, wantThinking:false, disableTools:true, jsonMode:true, _noWebSearch:true}`。
`wantThinking` 当前**未开启**（调用点未传），runtime 路径同样不传 → 与 direct 等价；`disableTools`/`timeoutMs` 经 `request.executor` 白名单进入执行器，`jsonMode` 走 Runtime 契约顶层字段，`budget` 走 `request.budget`。
`wantMeta` 两条路径内部不同（direct=false / ModelPort=true）但**有效返回值一致**（同一原始字符串，测试断言相等）。

---

## 4. Diary persistence 与 Runtime 的边界证明

**设计层面**：`_diaryModelCall` 的职责只有"发请求、返回模型原始文本"——函数体内没有 `dbPut`/`dbGet`/Memory/consolidation/scheduler 调用；所有副作用仍在 `generateDiaryEntry` 的原代码行上。

**测试层面**（包裹 `dbPut` 统计，真实 IndexedDB）：
| 场景 | Diary 写入 | Memory 写入 | 其他 dbPut |
|---|---|---|---|
| 成功（含 memoryCandidate） | 1 条（同一 id 的 2 次 put：写入 + 追加 memoryId，为既有行为；distinct id = 1） | 恰好 1 条（`source:'diary'`） | 0 |
| provider 失败 | 0 | 0 | **0（任何 dbPut 都没有）** |
| abort | 0 | 0 | 0 |
| gate=false / runtime 不可用 | 1 条（业务链正常） | 1 条 | 0 |

**visibility 语义**（成功后读取真实写入的 memory 行）：`visibility='only'`、`visibleTo=[characterId]`、`isMemoryVisibleTo(mem, 所属角色)=true`、`isMemoryVisibleTo(mem, 其他角色)=false` —— 与 P1-05 修复后的语义完全一致，未被 Runtime 触碰。

---

## 5. error / retry / abort 行为

| 场景 | 结果 | 证据 |
|---|---|---|
| provider error（HTTP 500） | 1 次调用 → `{ok:false}`；**不回落 direct**；不写 Diary/Memory | 1 条 telemetry、`fallbackReason=''`、`dbPut` 计数 0 |
| invalid JSON | 原 retry：第 2 次请求带原提示词 `【注意】上次输出不符合要求` → 成功 | 2 次请求 + 提示词断言 |
| 空 JSON（`{}`） | 原校验判失败 → 原 retry → 成功 | 2 次请求 + 提示词断言 |
| 去重命中 | 原逻辑不变（`_diaryDuplicateCheck` 在业务链内） | 未改动该函数；Phase 3 测试用不同 memory 内容规避跨角色去重 |
| timeout | 经 `request.executor.timeoutMs=120000` 透传，与 direct 一致 | 执行器选项 deepEqual |
| abort | signal 已中止 → 不发起调用；execute 返回 aborted → 抛 `AbortError`；既有 `catch(e){break}` 保证**不 retry** | 1 次请求 + 800ms 后仍 1 次；telemetry `abortReason='abort'` |
| fallback 时机 | 仅 `runtime_unavailable` / `gate_disabled` 两个**执行前**条件 | 两个用例分别断言 fallbackReason |

---

## 6. telemetry 复用情况

**复用，未扩 schema。** 直接使用 Phase 2 的 `IB.runtime.telemetry`：
- `consumer` 固定 `'diary'`（按要求）；`kind` 复用既有字段填 `'generate'`；
- 使用到的白名单字段：`executor / format / model / provider / characterId / kind / jsonMode / usage / abortMode / abortReason / fallbackReason / ok / ms`；
- **没有新增 Diary-specific 字段**（`kind`、`characterId` 已是跨 consumer 通用字段，Moments/Active 都在用）；
- sink 只有一行 `console.info('[Diary] model executor', record)`；
- 隐私：测试断言 telemetry 中不含 apiKey、prompt 正文（`CONV_SYS/CONV_USER/CONV_IDENTITY_`）、日记正文与 Memory 正文。

---

## 7. 完整测试结果

`node test-all.js --all`：**90 项全部通过，exit 0，488.5s**
（static 31 项 18.5s / service 16 项 86.2s / browser 43 项 383.8s）。

| 项目 | 命令 | 结果 |
|---|---|---|
| 全量 | `node test-all.js --all` | 90/90 通过 |
| Phase 3 Diary convergence | `node test_runtime_convergence_diary.js` | 16/16 通过（覆盖 23 项要求） |
| Phase 2 Moments convergence | `node test_runtime_convergence_moments.js` | 18/18 通过 |
| Phase 1 proactive convergence | `node test_runtime_convergence_proactive.js` | 14/14 通过 |
| Runtime Integration Audit | `node test_runtime_integration_audit.js` | 10/10 通过 |
| Runtime opt-in smoke | `node test_runtime_optin_smoke.js` | 11/11 通过 |
| Active/Diary targeted | `test_active_diary_smoke` / `test_proactive_phase2` / `test_proactive_trace` / `test_bgai_propagation` | 全部 exit 0 |
| Memory targeted | `test_memory_smoke` / `test_memory_consolidation` / `test_memory_lyric_gate` / `test_memory_repair_dryrun` / `test_understanding_thread` | 全部 exit 0 |
| localhost 浏览器 smoke | `node test_runtime_browser_audit.js`（--all 内） | 5/5 通过，runtime 计数 0 |
| file:// 浏览器 smoke | `node test_runtime_browser_audit.js --file` | 5/5 通过，runtime 计数 0 |

要求 23 项的覆盖映射：1-3（三协议 diary→runtime）／4（body+执行器选项 deepEqual）／5（budget）／6（identity）／7（timeout/wantThinking）／8（usage）／9（gate=false）／10（unavailable）／11（error 不双调用）／12（abort 不 retry）／13（invalid + 空 JSON 原 retry）／14（Diary 只写一条）／15（Memory 只写一次）／16-17（失败不写 Diary/Memory）／18（visibility 不变）／19（proactive 仍 runtime）／20（Moments 仍 runtime）／21-23（Chat/Group/Voice 计数 0）。

---

## 8. 是否发现新的 Runtime contract 缺陷

**本阶段未发现新的契约缺陷。**
- 本接缝所需的执行器选项（`timeoutMs` / `disableTools`）已在 Phase 1/2 进入 `request.executor` 白名单；`jsonMode` / `budget` 早已是契约字段；`wantThinking` 本调用点不开启，无需新增。
- 已知的**非缺陷但需登记**的边界：ModelPort 固定 `_noWebSearch:true`（与当前所有已迁移 consumer 的取值一致），若未来某个 consumer 需要联网搜索，需要把该开关也纳入白名单——当前无此需求，不在本阶段改动。
- 三协议请求构造、usage 归一、abort 语义、error 分类均未发现新问题。

---

## 9. 是否适合迁移第四个 consumer

**适合。** 依据：
- 同一接缝模式已连续三阶段验证（Active / Moments / Diary），每次只改一个文件的一处执行调用 + 一个回归测试；
- telemetry 已完全共用，第四个 consumer 只需一行 sink；
- 回滚粒度：全局开关 + 每域覆盖开关（`runtimeDiaryExecuteEnabled` / `runtimeMomentsExecuteEnabled` / 全局 `runtimeExecuteEnabled`）；
- 主链路仍未受影响（Chat/Group/Voice runtime 计数 0，全量 90/90 绿）。

继续保持纪律：新 consumer 只允许经 `execute`；禁止 `loadContext`/`composeMessages`；每个 consumer 迁移前先补该 consumer 的 convergence regression。

---

## 10. 推荐第四个 consumer

**角色私信生成 `_rlCall`（`assets/js/role-letters.js:168`）。**

理由：
- **一个接缝服务两个 consumer**：`_rlGenerateInit`（主动写信）与回信生成都经 `_rlCall`，一次迁移覆盖两条链路（与 Phase 2 的 Moments 形态相同）；
- 调用形态与本阶段一致：单次、非流式、`jsonMode:true`、`disableTools:true`、`wantMeta:false`，只是 `maxTokens` 按调用点不同（走 `budget`）；
- **零耦合**：它只调用 `window.callApiChat`，不触碰聊天/流式/工具链；记忆写入在独立的 `roleLetterMemories` 命名空间；
- 测试面已有：`test_role_letters.js`（41 项）覆盖私信生成/回信/隔离/冷却，补一个 convergence regression 即可。

**顺带可做（同一阶段内的小项）**：把 `diary.js:328` 的 `_diaryDailyPlanner` 也改走 `_diaryModelCall`（2 行），让 Diary 域的执行 100% 收敛——本阶段按边界要求未做。

**备选**：Understanding/Thread 生成（`active-diary.js:945`，单点 JSON，已有 3 个 understanding 测试）。**不建议**把 Chat/Group/Voice 作为第四个 consumer——它们需要先设计流式、工具与多成员契约。
