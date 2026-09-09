# InternalBeyond · Runtime Convergence Phase 2 报告

阶段：Runtime Convergence Phase 2（第二个生产执行接缝）。基准：Phase 1 完成后的工作区（`test-all --all` 88/88 全绿）。本次未提交 Git。

迁移对象：`assets/js/moments.js` → `_obsCall`（唯一执行接缝，服务三个 consumer：`generateRoleMoment` / `generateRoleComment` / `generateRoleReply`）。
迁移性质：**只替换模型执行层**；Moments 的 prompt/context 组装、JSON schema 与解析、评论/回复业务规则、event/ACK、scheduler、persistence、UI 全部未改。

---

## 1. 修改文件

| 文件 | 变化 |
|---|---|
| `assets/js/moments.js` | `_obsCall` 改为统一执行接缝：新增 `_momentsModelCall`（runtime/direct 分流）、`_momentsRuntimeGate`/`_momentsRuntimeInstance`/`_momentsFormat`/`_momentsExecLog`；三个 consumer 各加一行 `signal` 透传（`generateRoleComment` 增加可选第三参 `opts`）；双挂载 `_obsCall`/`_momentsModelCall` |
| `assets/js/agent-runtime.js` | ① `IB.runtime.telemetry`（统一诊断结构 + 字段白名单 + 环形缓冲）；② `request.executor` 白名单新增 `disableTools`（默认仍为 true） |
| `assets/js/active-diary.js` | Phase 1 的迁移诊断改为经统一 helper 生成记录（sink 仍是 `_activeProactiveLog`，结构与 Moments 不再各自漂移） |
| `test_runtime_convergence_moments.js` | 新增 Phase 2 convergence regression（18 个用例，覆盖要求的 20 项） |
| `test-all.js` | 登记新测试 |
| `docs/history/runtime/RUNTIME-CONVERGENCE-PHASE2-REPORT.md` | 本报告 |

未改动：`buildMomentPrompt` / `buildMomentCommentPrompt` / `buildMomentReplyPrompt`、`_momentsContext`、`_momentsParseOutput` / `_momentsParseCommentOutput` / `_momentsParseReplyOutput`、去重/频控/冷却/低信息过滤、`createMoment`/`addMomentComment`、event/ACK、`_momentsTick` 与 companion 同步、图片链路。

---

## 2. `_obsCall` 新旧调用链

**迁移前**
```
generateRoleMoment / generateRoleComment / generateRoleReply
  → _obsCall(kind,cfg,messages,opts)        ← 仅观测包装
      → callApiChat(cfg,messages,opts)      ← 直接执行器
```

**迁移后**
```
generateRoleMoment / generateRoleComment / generateRoleReply   （三个 consumer 未感知执行器差异）
  → _obsCall(kind,cfg,messages,opts)        ← 观测包装（OBS.callBegin/callEnd 逐行未改）
      → _momentsModelCall(kind,cfg,messages,opts)               ← 唯一执行接缝
          ├─ runtime：runtime.resolveModel(cfg) → spec{streaming:false}
          │            IB.runtime.instance.execute(
          │              { spec, messages, jsonMode, budget:opts.maxTokens,
          │                executor:{ timeoutMs, disableTools } },
          │              { signal, onEvent })
          │              → ModelPort → callApiChat → _callApiChatOnce → _ibApiPost → provider
          └─ direct：callApiChat(cfg,messages,opts)  （opts 原样，不追加任何字段）
```

回滚/降级判定（全部在接缝内部）：
| 条件 | 行为 | fallbackReason |
|---|---|---|
| `window.runtimeMomentsExecuteEnabled===false`（或未设时全局 `runtimeExecuteEnabled===false`） | direct | `gate_disabled` |
| `IB.runtime.instance.execute` 不可用 | direct | `runtime_unavailable` |
| `execute` 抛异常 / 返回 error / 中止 | 不回落，交给原 retry/错误链 | 记录 `runtime_execute_threw`（抛异常时） |

---

## 3. 三协议 JSON contract 对照

对同一 `cfg` + 同一 `messages` + 同一 opts（`maxTokens:2000, jsonMode:true, disableTools:true`）分别走 runtime 与 direct，捕获真实请求体并 `deepEqual`（测试逐字段比较，不是"最终 parse 成功"）：

| 维度 | OpenAI | Anthropic | Gemini |
|---|---|---|---|
| 请求体 runtime vs direct | 逐字段相同 | 逐字段相同 | 逐字段相同 |
| 返回原文 | 相同 | 相同 | 相同 |
| jsonMode 落点 | `response_format:{type:'json_object'}` | 不新增字段（与 direct 一致；jsonMode 仅用于端点不支持时的降级重试） | `generationConfig.responseMimeType='application/json'` |
| disableTools 落点 | 请求体无 `tools` | 无 `tools` | 无 `tools` |
| budget | `max_tokens=2000` | `max_tokens=2000` | `generationConfig.maxOutputTokens=2000` |
| identity/system 位置 | `messages[0].role='system'` | 顶层 `system` 字符串，messages 无 system | `system_instruction.parts[0].text` |
| model | body.model | body.model | URL `{model}` 替换 |
| provider/endpoint/credential | 同 cfg（spec 由 resolveModel 派生，无第二份 metadata） | 同 | 同 |

`jsonMode` 与 `disableTools` 都走**显式白名单**：前者是 Runtime 契约顶层字段 `request.jsonMode`，后者是 `request.executor.disableTools`（本阶段新加入白名单，未给出时默认 true）。不存在"偶然透传"。

---

## 4. direct / runtime 的 retry 与 abort 等价性

| 场景 | direct（原） | runtime（新） | 结论 |
|---|---|---|---|
| provider 错误（HTTP 500） | `callApiChat` 抛错 → `_obsCall` 抛出 → 消费者 `catch(e){lastError=e;break}` → 单次调用后返回 `{ok:false}` | 接缝把 `outcome.error` 重抛为等价 `Error`（带 `kind`） → 同一 `catch/break` | 等价；测试断言"恰好 1 次 provider 调用 + 0 条 direct 记录" |
| 输出无法解析（invalid JSON） | 解析失败 → 原提示词重写 → 第 2 次请求 | 同（解析/重试完全在消费者内，接缝只返回原始文本） | 等价；测试断言 2 次请求且第 2 次含原 `【注意】上次输出不符合要求` |
| 空响应 | `_momentsParseOutput('')===null` → 原重试/诊断链 | 同 | 等价 |
| timeout | 由 `opts.timeoutMs` 控制（moment 120s / comment·reply 90s），经 `request.executor.timeoutMs` 白名单透传 | 同 | 等价 |
| abort | 无 signal（不可能发生） | signal 已中止 → 接缝抛 `AbortError`；execute 返回 `aborted` → 抛 `AbortError` | 新增能力；消费者既有 `catch/break` 保证**不重试**，测试断言 1 次请求 + 800ms 后仍为 1 次 |
| 已发出请求后再回落 direct | — | **禁止**：`execute` 抛错/返回 error 时绝不回落 | 测试断言本次调用只产生 1 条 telemetry、`fallbackReason=''` |

---

## 5. telemetry 是否成功复用

**是，且已收敛为一份结构。** `IB.runtime.telemetry`（`assets/js/agent-runtime.js`）提供：
- `record(consumer, data)` → 生成白名单记录（字段表：`consumer/executor/provider/format/model/usage/jsonMode/abortMode/abortReason/fallbackReason/attempt/taskId/characterId/kind/ok/ms`），白名单之外的键（`apiKey`/`prompt`/`messages`/正文/Memory）**在结构上不可能被记录**；
- `recent(n)` 环形缓冲（200 条）供测试/诊断读取；
- `build()` 供需要自定义 sink 的场景复用。

两个 consumer 只保留 3 行 sink 适配：Active 用 `_activeProactiveLog('model executor', …)`，Moments 用 `console.info('[Moments] model executor', …)`。字段结构、白名单、隐私边界统一在 Runtime 一处维护，不再各自漂移。

Moments 记录示例字段：`{consumer:'moments', kind:'moment|comment|reply', executor:'runtime|direct', format, model, jsonMode:true, usage:'present'|'absent'|'unavailable', abortReason, fallbackReason, ok, ms}`。

---

## 6. 全量测试结果

`node test-all.js --all`：**89 项全部通过，exit 0，461.3s**
（static 31 项 17.7s / service 16 项 84.2s / browser 42 项 359.4s）。

---

## 7. 运行记录

| 项目 | 命令 | 结果 |
|---|---|---|
| 全量 | `node test-all.js --all` | 89/89 通过 |
| Phase 2 Moments convergence | `node test_runtime_convergence_moments.js` | 18/18 通过 |
| Phase 1 proactive convergence | `node test_runtime_convergence_proactive.js` | 14/14 通过 |
| Runtime Integration Audit | `node test_runtime_integration_audit.js` | 10/10 通过 |
| Runtime opt-in smoke | `node test_runtime_optin_smoke.js` | 11/11 通过 |
| Moments targeted | `test_moments_smoke` / `phase2_smoke` / `phase4_smoke` / `user_smoke` / `socialnet_chain_smoke` / `moments_companion` / `moments_http` | 全部 exit 0 |
| localhost 浏览器 smoke | `node test_runtime_browser_audit.js`（--all 内） | 5/5 通过，runtime 调用计数 0 |
| file:// 浏览器 smoke | `node test_runtime_browser_audit.js --file` | 5/5 通过，runtime 调用计数 0 |

Phase 2 regression 的 18 个用例与要求的 20 项对应关系：1-3（三协议 moment→runtime）／4（comment）／5（reply）／6（jsonMode）／7（disableTools）／8（budget）／9（identity）／10（usage）／11（invalid JSON 原 retry）／12（error 不双调用）／13（abort 不 retry，含接缝层）／14（gate=false）／15（runtime unavailable）／16（三 consumer 共用接缝）／17（proactive 仍 runtime）／18-20（Chat/Group/Voice 计数 0）；另有 telemetry 复用与隐私断言。

## 8. 是否发现 Runtime 新契约缺陷

发现 1 处**契约缺口**并修复：
- `request.executor` 白名单缺少 `disableTools` → 若消费者需要与 direct 的 `opts.disableTools` 逐位一致（本次 Moments 三个调用点均传 `true`），只能依赖 ModelPort 硬编码的 `disableTools:true`，属于"偶然透传"。已把 `disableTools` 纳入白名单（未显式给出时默认仍为 `true`，不改变既有消费者行为）。

未发现：三协议请求体构造、`jsonMode` 落点、usage 归一、abort 语义、error 分类上的新缺陷。Phase 1 的 proactive consumer 在重构 telemetry 后仍全绿。

---

## 9. 是否适合继续第三个 consumer

**适合。** 依据：
- 同一套接缝模式已连续两次验证（Phase 1 Active、Phase 2 Moments），且 Moments 证明**一个接缝可同时承载三个 consumer**；
- 统一 telemetry 已抽到 Runtime，第三个 consumer 只需 3 行 sink 适配；
- 回滚粒度可控（全局开关 + 每 consumer 覆盖开关）；
- 主链路仍未被触及（Chat/Group/Voice 计数 0，全量测试绿）。

纪律不变：新 consumer 只允许经 `execute`，禁止接入 `loadContext`/`composeMessages`；每迁一个 consumer 前先补该 consumer 的 convergence regression。

---

## 10. 推荐第三个 consumer

**日记生成 `_diaryWriteMemory` 所在的日记生成链（`assets/js/active-diary/diary.js`）。**

理由：
- **低耦合、非流式、单点**：日记生成与 `generateProactiveMessage` 同构（单次 `callApiChat` + JSON 解析 + 原重试/兜底），且只有一条执行路径；
- **与已迁移的 Active 同域**：两者共享 `active-diary.js` 的日志/调度习惯，回归面清晰，可复用 Phase 1 的测试骨架；
- **测试面已有**：`test_active_diary_smoke.js` 覆盖日记生成/解析/落库，`test_memory_consolidation.js` 覆盖相邻的记忆写入链；
- 不涉及 UI 流式、不涉及 companion 事件回传，风险低于 Moments。

备选（同样低耦合）：`consolidateCharacterMemory`（记忆固化，单一调用点、后台 JSON）。**不建议**把 Chat/Group/Voice 作为第三个 consumer——它们是流式/工具/多成员路径，需要单独设计流式与工具契约。
