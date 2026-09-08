# InternalBeyond · Runtime Convergence Phase 1 报告

阶段：Runtime Convergence Phase 1（只迁移一个生产 consumer）。基准：P2 Contract Closure 完成后的工作区（`test-all --all` 87 项全绿）。本次未提交 Git。

迁移对象：`assets/js/active-diary.js` → 浏览器 `generateProactiveMessage`（主动消息生成）。
迁移性质：**只替换最终模型执行接缝**，prompt / context / 校验 / 去重 / retry / fallback 全部不变。

---

## 1. 修改文件

| 文件 | 变化 |
|---|---|
| `assets/js/active-diary.js` | 新增执行接缝 `_activeProactiveModelCall`（含 `_activeRuntimeProactiveCall` / `_activeDirectProactiveCall`）、迁移开关 `window.runtimeExecuteEnabled`、迁移诊断 `_activeProactiveExecStats`/`_activeProactiveExecStatsSnapshot`；`generateProactiveMessage` 改为调用该接缝（循环/校验/兜底逻辑逐行保留） |
| `assets/js/agent-runtime.js` | ModelPort 新增 `request.executor` **白名单透传**（`wantThinking` / `timeoutMs` / `heartbeatMs`），使迁移能保持既有执行器语义；其它键一律忽略 |
| `test_runtime_convergence_proactive.js` | 新增 convergence regression（14 项，真实 localhost 页面 + mock provider） |
| `test-all.js` | 登记新测试（browser 组） |
| `test_moments_phase3_smoke.js` | **测试隔离修复（与本迁移无关的既有抖动）**：暂停后台 `_activeTimer`，避免 30s 后台 tick 与本测试的 companion 请求计数/mock 每模型计数竞争；4/4 次独立运行稳定 |
| `docs/RUNTIME-CONVERGENCE-PHASE1-REPORT.md` | 本报告 |

未改动：`loadProactiveMessageContext`、`buildProactivePrompt`、`_activeVisibleProactiveReply`、`_activeValidateProactiveReply`、`_activeFallbackMessage`、`ACTIVE_PROACTIVE_MAX_ATTEMPTS`、`_activeExecuteRun`/`_activeStoreMessage`、`active-plans.js` 调用方。

---

## 2. 新旧调用链

**迁移前（direct）**
```
_activeGenerate / _activeExecuteAiPlan
  → loadProactiveMessageContext → buildProactivePrompt            （本次未改）
  → generateProactiveMessage
      → requestModel(cfg, messages, {maxTokens:512,timeoutMs:120000,wantThinking:true,result,_noWebSearch:true,disableTools:true})
      → callApiChat → _callApiChatOnce → _ibApiPost → provider
```

**迁移后（runtime，默认）**
```
_activeGenerate / _activeExecuteAiPlan
  → loadProactiveMessageContext → buildProactivePrompt            （完全未改）
  → generateProactiveMessage
      → _activeProactiveModelCall                                   ← 唯一执行接缝
          → runtime.resolveModel(cfg) → ModelSpec{…, streaming:false}
          → IB.runtime.instance.execute(
                { spec, messages, budget:512, executor:{wantThinking:true, timeoutMs:120000} },
                { signal, onEvent })
              → defaultModelPort.run → 重建最小 cfg → callApiChat → _callApiChatOnce → _ibApiPost → provider
```

**回滚/降级路径（同一条接缝内）**
```
window.runtimeExecuteEnabled === false          → callApiChat 直连（fallbackReason='gate_disabled'）
IB.runtime.instance.execute 不可用              → callApiChat 直连（fallbackReason='runtime_unavailable'）
args.requestModel 被调用方注入                  → 注入的执行器（fallbackReason='injected_executor'）
execute 抛异常 / 返回 error                     → 不回落，交给既有 retry 循环（避免双模型调用）
signal 已中止                                   → 不发起任何调用，抛 AbortError
```

Runtime 路径底层仍调用同一个 `callApiChat`——本阶段收敛的是"谁来调度执行"，不是重写执行器。

---

## 3. Runtime 与 direct 路径的契约对照

| 维度 | direct（迁移前） | runtime（迁移后） | 等价性证据 |
|---|---|---|---|
| provider / model / endpoint / apiKey | 直接用 `cfg` | `resolveModel(cfg)` → ModelSpec → ModelPort 重建最小 cfg（含 id/maxTokens/promptCache/vision/systemPrompt/streaming） | 测试逐字段比较两次请求体（`deepEqual`） |
| format | `_providerFormat(cfg)`（provider-directory） | `resolveModel(cfg).format`（同源 provider-directory） | 三协议分别断言 anthropic/gemini/openai |
| budget / maxTokens | `maxTokens:512` | `budget:512` → `callOpts.maxTokens=512` | mock 观测 `max_tokens=512` / `generationConfig.maxOutputTokens=512` |
| identity（system） | `buildProactivePrompt` 产出的 `messages[0].system` | 同一 `messages` 原样透传 | 请求体逐字段一致；三协议分别断言 system 位置 |
| wantThinking / timeoutMs | 直接传执行器 | 经 `request.executor` 白名单透传（新增） | 迁移后请求与 direct 完全一致 |
| usage | `result.usage`（`{i,cr,cw,o}`，`_tkRecord` 回传） | `outcome.usage` 归一为 `{input_tokens,output_tokens,total_tokens,cached_tokens}`，`usageSource='executor'` | 三协议断言归一值（20/4/24/3、17/4/21/3、20/4/24/0） |
| abort | 不支持（无 signal） | 支持 signal；本 consumer 走 `abandon` 模式（非流式），中止后 `aborted=true`、`text=''`、抛 AbortError | 单次调用断言 + 800ms 内无第二次请求 |
| provider error | 抛错 → retry → 兜底 | 接缝把 `outcome.error` 重抛为等价 Error（带 `kind`）→ 同一 retry → 同一兜底 | 3 次尝试 + `generatedByFallback=true` + 兜底文案非空 |
| 空响应 | 空文本 → 既有校验拒绝 → retry | 同 | 由 retry 用例覆盖 |
| 文本最终处理 | `_activeVisibleProactiveReply` + `_activeValidateProactiveReply` | 同（`call.text` / `call.reasoning` 对应原 `raw` / `result.reasoning_content`） | 正文与 direct 逐字节一致 |

---

## 4. 回滚机制

1. **总开关（代码零改动回滚）**：`window.runtimeExecuteEnabled = false` → 下一条主动消息立即回到 `callApiChat` 直连；`fallbackReason='gate_disabled'` 记录在诊断中，测试断言"关闭后正文与 runtime 路径逐字段一致"。
2. **注入优先**：调用方传 `args.requestModel` 时永远使用注入的执行器（测试与自定义场景），记为 `injected_executor`。
3. **自动降级**：Runtime 未加载 / 无 `execute` → 回落 direct 并记 `runtime_unavailable`。
4. **禁止双调用**：`execute` 抛异常或返回 error 时**不**回落（可能已经发生过模型调用），交给既有 retry 循环；abort 后既不重试也不回落。
5. **可观测**：`_activeProactiveExecStatsSnapshot()` 返回 `{runtime, direct, abort, lastExecutor, lastFallbackReason, lastAbortReason}`；每条消息还会打一条 `[ProactiveMessage] model executor` 诊断。

---

## 5. 测试结果

新增 `test_runtime_convergence_proactive.js`（14 项，全部通过）：
1. OpenAI format → runtime；2. Anthropic → runtime；3. Gemini → runtime（三协议各自校验请求 wire + 正文）
4. usage 正确回传（三协议归一值）；5. budget=512 保持；6. provider/model identity 保持；
7. abort 单次调用（不重试、不回落、无第二次请求）；8. runtime error → 既有 retry + 兜底行为不变；
9. proactive retry 原样（相似拒绝 → 带 `重新生成要求` 重生成，恰好 2 次调用）；
10. runtime ↔ direct 等价（正文 + `generatedByFallback` + 请求体 `deepEqual` + `gate_disabled` 记录）；
11. Chat 计数 0；12. Group 计数 0；13. Voice 计数 0（并断言三者的对照组本身可用）；
14. 迁移诊断已发出且不含 apiKey / prompt / 消息正文；另有"计数器自证"断言 proactive 恰好调用一次 `runtime.execute`。

完整验证（见 §7 运行记录）：`test-all.js --all`、Runtime Integration Audit、Runtime opt-in smoke、proactive 定向测试、localhost 与 file:// 浏览器 smoke。

---

## 6. 是否发现 Runtime execute 新缺陷

**发现并修复 2 处（都属于"迁移才暴露"的契约缺口，不是执行器语义错误）：**
1. **ModelPort 缺执行器选项透传**：`wantThinking` / `timeoutMs` 无法传给执行器 → 迁移会静默把 120s 超时降为 60s、并改变 thinking 分流开关。已补 `request.executor` 白名单透传（仅 3 个键，其它忽略）。
2. **本阶段新增诊断的陈旧值**：`lastFallbackReason` 会残留上一次调用的原因（测试第一次运行抓到 `runtime_execute_threw` 误报）。已改为每次进入接缝先清空。

**未发现** Runtime execute 在三协议请求构造、响应解析、usage 归一、abort 语义上的新缺陷；opt-in smoke（11 项）与 convergence regression（14 项）均通过，主 Chat/Group/Voice 的 runtime 调用计数仍为 0。

---

## 7. 运行记录

最终 `node test-all.js --all`：**88 项全部通过，exit 0，总耗时 441.3s**
（static 31 项 17.4s / service 16 项 83.0s / browser 41 项 340.9s）。

定向验证：
| 项目 | 命令 | 结果 |
|---|---|---|
| 全量 | `node test-all.js --all` | 88/88 通过 |
| Runtime Integration Audit | `node test_runtime_integration_audit.js` | 10/10 通过 |
| Runtime opt-in smoke | `node test_runtime_optin_smoke.js`（含在 --all） | 11/11 通过 |
| Convergence regression | `node test_runtime_convergence_proactive.js` | 14/14 通过 |
| proactive 定向 | `test_proactive_trace` / `test_proactive_phase2` / `test_bgai_propagation` / `test_proactive_interaction` / `test_active_http` / `test_active_plans` / `test_active_diary_smoke` | 全部通过（在 --all 内） |
| localhost 浏览器 smoke | `node test_runtime_browser_audit.js`（--all 内） | 5/5 通过，runtime 调用计数 0 |
| file:// 浏览器 smoke | `node test_runtime_browser_audit.js --file` | 5/5 通过，runtime 调用计数 0 |

过程中的两处**测试自身**不稳定（均非产品缺陷，已修并复验）：
- `test_moments_phase3_smoke.js`：后台 `_activeTimer`（30s）在测试窗口内触发 `_momentsTick`/`_momentsSyncCompanion`，干扰 companion 请求计数与 mock 每模型调用计数（表现为 `sync.burstCutOn404` / `reown.ownershipSelfHeals` / `rsn.adaptiveRetryPublishes` 随机失败；独立运行 3 次中 1 次失败且每次失败项不同）。修复：测试内暂停后台调度（本测试所有 tick 都是显式调用），4/4 次稳定通过。
- `test_runtime_convergence_proactive.js`（本阶段新增）：初版按端点计数，被后台日记/计划 tick 的同端点请求污染；改为按请求体标记（身份串/`CONV_ABORT`）计数后稳定。

## 8. 是否适合继续迁移第二个 consumer

**适合。** 理由：
- 执行接缝的形状已被证明可承载"单次、非流式、可选 jsonMode、带 budget/identity/usage/abort"的 consumer；
- 回滚开关 + fallbackReason + telemetry 三件套已就位，第二个 consumer 可直接复用同一模式；
- 主链路未被波及（Chat/Group/Voice 计数 0，全量测试绿）。

建议在迁移第二个 consumer 前保持一条纪律：**新 consumer 只允许经 `execute`，禁止使用 `loadContext`/`composeMessages`**（context 收敛仍是独立阶段，P2-03/P2-04 未修）。

---

## 9. 推荐第二个 consumer

**Moments 生成/评论/回复的统一接缝 `_obsCall`（`assets/js/moments.js:34`）。**

理由：
- 它是**一个接缝服务三个调用点**（`generateRoleMoment` / `generateRoleComment` / 回复链），一次迁移覆盖三个 consumer，收益最高；
- 调用形态与本次一致：单次、非流式、`jsonMode:true`、`disableTools:true`、`_noWebSearch:true`，仅 `maxTokens` 因调用点不同（800/300/…）→ 用 `budget` 逐点传即可；
- `jsonMode` 已是 Runtime 契约内的字段（`request.jsonMode`），无需扩展；
- 测试面最厚（phase2/3/4 三个 smoke + `test_moments_companion.js`），回归成本可控。

**备选（风险更低但收益更小）**：`consolidateCharacterMemory`（单一调用点、后台 JSON），适合作为第二个 consumer 的"低风险验证"。

不推荐作为第二个：Diary（覆盖面小）、Chat/Group/Voice（本阶段明确禁止）。
