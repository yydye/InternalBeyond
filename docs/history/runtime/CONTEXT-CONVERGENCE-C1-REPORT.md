# InternalBeyond · Context Convergence C1 报告（P2-03）

阶段：Context Convergence C1 —— 单轮上下文重复 retrieval / 重复注入 / 重复 activation。基准：Runtime Convergence Phase 1–4 完成后的工作区（`test-all --all` 91/91）。本次未提交 Git。

改动范围：**只改"谁负责读取、如何传递已有结果"**。`assets/js/middle-brain.js` **零改动**（`opts.*Ctx` 接缝本就存在）；Memory/Understanding/Thread/Moments 的检索算法、admission、ranking、visibility、token budget、provider/model 选择全部未动。

---

## 1. 原重复 retrieval 的精确调用链

迁移前（单聊一轮，`_buildSingleChatContext`）：

```
sendChatMessage
  → buildChatContext → _buildSingleChatContext
      ① communication.js:1348  getMemoryContext(cfg.id,{userMessage})      ← 读 memories + **写 activationCount/lastActivated**
      ② communication.js:1351  getUnderstandingContext(cfg.id)             ← 读 understandings
      ③ communication.js:1353  getThreadContext(cfg.id)                    ← 读 threads
      ④ communication.js:1355  getMomentsContext(cfg.id,{userMessage})     ← 读 moments
      ⑤ communication.js:1365  middleBrainCompressPipeline(cfg.id,_ctxText,{})   ← **opts 为空**
            → middleBrainAdmissionGate(...)
                 → _mbAnalyzeSignals(...)            （middle-brain.js:801）
                     → opts.organized 缺失 → middleBrainOrganizeContext(...)  → 再次 ①②③④
            → middleBrainAstraInvoke(...)             （middle-brain.js:644）
                     → middleBrainOrganizeContext(...)                            → 再次 ①②③④
            → 若 Astra 失败 → middleBrainContextPipeline(...)（middle-brain.js:575）
                     → middleBrainOrganizeContext(...)                            → 再次 ①②③④
      ⑥ communication.js:1367  把 Astra compressedContext **追加**到 _tailCtx（①②③④ 原块仍在）
```

`middleBrainOrganizeContext` 的判定是 `if (opts.memoryCtx != null) {...} else if (typeof root.getMemoryContext === 'function') { 再读 }`（`middle-brain.js:454/462/470/478`）——因为传的是 `{}`，四个块全部走 else 分支。

后果（已复现）：
- `getMemoryContext` 一轮被调用 **2 次**（`admissionEnabled:false` 路径）或最多 4 次（开启 admission gate 时 gate signals + Astra/本地 pipeline 各一次）；
- `activationCount`/`lastActivated` 一轮 **+2**（激活计数副作用，memory.js:117–123）；
- 同一语义块在最终 prompt 中出现**两份**（原始块 + Astra 压缩块），token 反而增加。

---

## 2. 每个 context producer 的新 owner

| context block | 生产函数 | 读取 owner（C1 之后） | Middle Brain 的角色 |
|---|---|---|---|
| Memory | `getMemoryContext(cfg.id,{userMessage})` | `_buildSingleChatContext`（一轮一次） | 消费 `opts.memoryCtx` |
| Understanding | `getUnderstandingContext(cfg.id)` | 同上 | 消费 `opts.understandingCtx` |
| Thread | `getThreadContext(cfg.id)` | 同上 | 消费 `opts.threadCtx` |
| Moments | `getMomentsContext(cfg.id,{userMessage})` | 同上 | 消费 `opts.momentsCtx` |

规则（已由代码与测试共同锁定）：
- 上游已读取 → Middle Brain **只消费**，不再触发任何 retrieval 或 activation；
- 上游未提供（`undefined`）→ Middle Brain 允许 fallback retrieval（保持独立可用性，`test_middle_brain_ctx.js` 的 `reuse.existingRetrieval` 仍然成立）；
- 上游读取但为空（`''`）→ Middle Brain **不得**再读。

未被 Middle Brain 处理、由上游独占的块：时间 / 音乐 / 日历 tail / 对话摘要 / Auto Memory tail / Activity / 工作区与工具结果。

---

## 3. opts 传递字段

使用**既有**接缝字段（名称以生产代码现状为准，未新建 carrier）：

```js
window.middleBrainCompressPipeline(cfg.id, _ctxText || '', {
  memoryCtx:        _memCtx,   /* getMemoryContext 的真实返回（'' 表示已读为空） */
  understandingCtx: _uCtx,     /* getUnderstandingContext 的真实返回 */
  threadCtx:        _tCtx,     /* getThreadContext 的真实返回 */
  momentsCtx:       _momCtx    /* getMomentsContext 的真实返回 */
});
```

未传递（保持原语义）：`dialogue`（迁移前也未传，传了会改变 Astra 输入内容）、`organized`、`signals`、`state`、`timeoutMs`。

---

## 4. missing vs empty 语义

| 传入值 | `middle-brain.js` 判定 | 行为 |
|---|---|---|
| `undefined` / `null`（调用方没提供） | `opts.memoryCtx != null` 为假 | 走 fallback retrieval |
| `''`（调用方已读，结果为空） | `!= null` 为真、`if('')` 为假 | 不再 retrieval；`organized.memory = []` |
| 非空字符串 | 两个判定都为真 | 直接作为该 block 内容 |

因此**不存在 truthy 简写导致的"空结果二次读取"**：`_buildSingleChatContext` 始终把四个变量（初值 `''`）传给 pipeline。测试用"显式传 `''` → 四个 producer 计数为 0"和"传 `{}` → 四个 producer 计数各 1"两条用例把该语义钉住。

---

## 5. activation 去重证明

- `getMemoryContext` 是四个 producer 中**唯一**有读时副作用的（`memory.js:117–123` 对入选记忆 `activationCount+1`、`lastActivated=Date.now()`）；`getUnderstandingContext` / `getThreadContext` / `getMomentsContext` 经代码核对为纯读（无写库）。
- 测试（真实 IndexedDB + 全局函数包裹计数）：单聊一轮后
  - `getMemoryContext / getUnderstandingContext / getThreadContext / getMomentsContext` 调用计数 = **1 / 1 / 1 / 1**；
  - 被召回的记忆 `activationCount === 1`（迁移前为 2）；
  - 连续两轮 → 2 / 2 / 2 / 2（无隐藏二次读）。
- 由于 C1 只改调用点、不改 `getMemoryContext` 本身，激活计数算法与排序语义不变。

---

## 6. 每个 context block 的 passthrough / replace / augment 决策

| block | 决策 | 依据 |
|---|---|---|
| Memory | **replace** | Astra 输出是对 Memory 的筛选/合并/重写表示；原块 + 压缩块同时注入即重复语义 |
| Understanding | **replace** | 同上 |
| Thread | **replace** | 同上 |
| Moments | **replace** | 同上 |
| 对话摘要 / 时间 / 日历 tail / Auto Memory tail / Activity / 工作区与工具结果 | **passthrough** | 不进入 Middle Brain 输入，原样保留、不重复 |
| （无） | **augment** | 当前 pipeline 不存在"产生语义独立新信息"的输出：Astra 的 `compressedContext` 恒为上述四块的重写表示，因此本阶段**没有 augment 块**；若未来出现独立新增信息，应作为新 block 单独判定，不得混入 replace |

实现方式（`communication.js:1343–1381`）：
- 四个块经 `_pushCtxBlock()` 追加，同时把"精确拼接串"记入 `_ctxJoined`；
- Astra 成功（`_mbRes.source==='astra' && compressedContext`）→ 用压缩块**就地替换** `_ctxJoined`（`_tailCtx.slice(0,idx) + '\n\n' + _mbBlock + _tailCtx.slice(idx+len)`），而不是追加；
- `source==='local'`（Astra 不可用/失败/超时）或未启用 → 不做任何替换，四个块原样保留（与迁移前逐字段等价）；
- 四块全空时 `_ctxJoined===''`，Astra 也不会产生 `compressedContext`（`hasAnything` 为假）→ 不会插入空块。

---

## 7. 最终 prompt 是否仍存在重复语义

**不存在重复注入。** 测试断言（Astra 成功路径的真实聊天请求体）：
- 含 `C1_MB_COMPRESSED`（压缩块）**恰好一次**；
- 原始四块标记 `C1_MEMORY_MARKER` / `C1_UNDERSTANDING_MARKER` / `C1_THREAD_MARKER` / `C1_MOMENT_MARKER` **全部为 0 次**；
- passthrough 块（对话摘要）**恰好 1 次**，未因替换逻辑被复制或丢失；
- Middle Brain 关闭、以及 Astra 失败回落本地时，尾段与"Middle Brain 关闭"的基准**逐字段等价**（时间行归一化后 `deepEqual`）。

---

## 8. 全量测试结果

`node test-all.js --all`：**92 项全部通过**（static 31 / service 16 / browser 45），退出码 0。

| 项目 | 结果 |
|---|---|
| C1 regression（`test_context_convergence_c1.js`） | 12/12 通过（覆盖要求 19 项 + 快照等价） |
| Runtime Integration Audit | 10/10 |
| Phase 1–4 convergence regressions | 14 / 18 / 16 / 20 全通过 |
| Middle Brain targeted | `test_middle_brain` / `_admission` / `_advanced` / `_astral` / `_ctx` / `_judge` 全通过 |
| Memory targeted | `test_memory_smoke` / `test_memory_consolidation` / `test_memory_lyric_gate` / `test_memory_repair_dryrun` 全通过 |
| Understanding / Thread | `test_understanding_admission` / `_generation` / `_thread` 全通过 |
| localhost / file:// browser smoke | 各 5/5，runtime 调用计数 0 |
| Runtime execute 4 consumer | proactive / Moments / Diary / Consolidation 仍走 Runtime；Chat / Group / Voice 计数 0 / 0 / 0 |

**测试侧隔离修复（与本阶段生产改动无关，但为保持全绿所必需，均已复验）**：`test_moments_phase3_smoke.js` 的两类不稳定来自后台调度与 CDP 日志投递，不是产品缺陷：
1. `init()` 里的 `setTimeout(_activeTick,2500)` 一次性 tick + 30s `_activeTimer` 会与本测试的 companion 请求计数、mock 每模型调用计数竞争（表现为 `sync.burstCutOn404` / `reown.ownershipSelfHeals` 随机失败）。修复：先等一次性 tick 跑完（此时无配置、无副作用），再装常驻守卫清空 `_activeTimer`。3 个并发实例 × 1 轮压力运行 0 失败。
2. `rsn.adaptiveRetryPublishes` / `rsn.diagStageEmptyOutput` 依赖 CDP `Runtime.consoleAPICalled` 投递 console.warn，在负载下会延迟/漏送（曾出现 `rsnokHits:2` 且已发布、但 `retryLine:false`）。修复：改为**页面内**记录 `console.warn` 后再断言（断言内容不变，且不再依赖 CDP 投递）。

---

## 9. 是否发现新的 context contract 缺陷

发现 1 处**语义缺口**（非缺陷，但需登记）：`middleBrainContextPipeline` / `middleBrainAstraInvoke` / `_mbAnalyzeSignals` 三处都会调用 `middleBrainOrganizeContext`，而 `opts.organized` 这个"已组织结果直传"字段只被 `_mbAnalyzeSignals` 使用，pipeline 没有把 organize 结果向上传递。C1 通过 `opts.*Ctx` 把检索收敛为一次，因此**不依赖**该字段；但若将来要让 Middle Brain 的 organize 也只跑一次，需要让 pipeline 把 `organized` 透传给 `_mbAnalyzeSignals` / `middleBrainAstraInvoke`——属于 C2 的候选（本阶段未做，避免扩大改动面）。

未发现：visibility 被绕过、跨角色泄漏、identity/characterId 被 Middle Brain 修改、空结果被当成缺失。

---

## 10. 是否适合进入 C2 canonical Context

**适合，且建议先做一件收尾再进 C2。**

已具备的前置条件：
- 单轮每 producer 一次读取已被测试锁定（可回归、可回滚）；
- `missing vs empty` 语义已明确并被测试钉住，C2 可以直接把 `''`/`undefined` 的区分作为 canonical 契约的一部分；
- Middle Brain 的输出语义已逐块声明（replace/passthrough），C2 定义 canonical 形状时不必再猜"谁该替换谁"。

建议 C2 的第一步（最小、可验证）：把 `P2-CONTEXT-CONVERGENCE-AUDIT.md` §2.4 的字段清单落成**一个只读的 Context 快照对象**（producer / value / empty-vs-missing / visibility 已过滤 标记），先只让 `_buildSingleChatContext` 与 `middle-brain.js` 共用它，不改注入顺序、不改任何 producer 算法；确认"同轮快照与现网 prompt 等价"后再考虑把 4 个生产者逐个映射过去。

**不建议**在 C2 一开始就动 roleLetterMemories parity 或 browser/companion 全量统一（那是 C2 之后的独立议题），也**不要**在 Context 收敛完成前启动 Chat 的 execute 迁移——否则流式/工具契约与上下文契约会互相掩盖问题。
