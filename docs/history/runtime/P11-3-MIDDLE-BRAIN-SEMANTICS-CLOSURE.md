# P11-3 · Middle Brain Runtime Semantics Closure

范围：修正 Runtime Participation Audit（P11 审计）暴露出的**状态语义 / fallback 语义 / turn 生命周期**问题。
本阶段**不新增 Middle Brain 能力**、**不为了让审计显示 FULLY PARTICIPATING 而改判定**、
**不改 Judge / OOC Guard 默认值**、**不迁 Group / Tool / Continue**。
证据等级：A（真实页面 + CDP + mock 端点，一次真实普通单聊请求；local 结果以 mock 角色端点收到的请求体为准）。

---

## A. 根因

| # | 问题 | 根因 | 证据 |
|---|---|---|---|
| A1 | `UI = Enabled` 而 `runtime = Disabled` | 徽标读的是**编辑态** `_mbUi.enabled`；`mb-enabled-toggle` 的 change 只改它、不落盘；而 runtime 只读持久化 `apiSettings['middle_brain']`。两者来源不同 → 未保存时"看起来已生效"。 | `middle-brain-config.js`（改前）`_mbRenderHeader` 用 `_mbUi.enabled`；`_mbBindCollapse` 的 change 只做 `_mbUi.enabled=…; _mbRenderHeader()` |
| A2 | 缺 dirty/unsaved 概念 | enabled / endpoint / API Key 是"Save 才生效"，但卡片其余控件（model / reasoning / speed / imageMode / integrity）是"点击即写"。同一张卡片里两种保存语义并存，却没有任何"未保存"表达。 | `saveMiddleBrainConfigUI` vs `_mbModelSet` / `mbReasoningPick` / `mbSpeedPick` / `mbImageModePick` / `mbCiPersist` |
| A3 | `mb-collapse-toggle` 不存在时，enabled 开关的绑定被顺带跳过 | `_mbBindCollapse` 开头 `var t=_mbEl('mb-collapse-toggle'); if(!t) return;` 在绑定 enabled 之前 | 同函数（改前） |
| B1 | `source==='local'` 的产物不进最终请求 | consumer 硬编码 `if(_mbRes.compressedContext && _mbRes.source==='astra')`。local 只在"迁移零改动"的意义上被排除（注释：*避免重复/歧义*），**没有任何契约禁止它注入** | `communication.js`（改前）注入分支 + `test_frontend_structure.js` 的 `middleBrain.localNoInject` 守卫 |
| B2 | 于是出现"MB 开着但对请求零影响"的死区 | `middleBrainReady()` 需要 apiKey，`isMiddleBrainEnabled()` 不需要 → `enabled + 无 Key` 时 Gate 判 `astra_not_ready` → local；local 又不注入 → 用户以为开了 MB，实际什么都没发生 | 审计结论（PARTIALLY PARTICIPATING）+ Gate `astra_not_ready` 分支 |
| C1 | turn 生命周期没有契约 | MB 的调用点在 **context 构建**（`_buildSingleChatContext`），每个用户 turn 只发生一次；tool continuation 靠复用主轮 `messages` 顺带继承 MB 块。也就是说当前是"隐式 turn-scoped"，不是有契约的 turn-scoped | `_wsToolContinue` 的 `(o.messages||[]).slice()`；见 §E |

---

## B. 修改文件

| 文件 | 改动 |
| --- | --- |
| `assets/js/middle-brain-config.js` | 抽出唯一 runtime 谓词 `_mbRuntimeEnabled(c)`；新增编辑态/runtime 态双状态（`_mbSaved` pristine 快照 + `_mbRuntime` 镜像 + `_mbDirty()` + `_mbBadgeState()`）；徽标改为 runtime 三态；endpoint/API Key 绑 `input` 只刷 dirty；保存成功才刷新 runtime；`_mbBindCollapse` 三个绑定互相独立 |
| `assets/js/communication.js` | 新增 `_mbInjectable(res,userMessage)` 显式三态注入契约；注入分支改用它；trace `source` 写具名三态（astra / local / bypass） |
| `assets/js/middle-brain.js` | 执行缝注释改为三态契约；`middleBrainExecute` 返回 `null` 时把 trace `source` 标记为 `bypass` |
| `assets/css/core.css` | `.mb-collapse-badge.is-dirty`（虚线边框） |
| `tests/test_middle_brain_semantics.js`（新增） | A：UI/runtime 状态机（真实 config 层 + DOM/IndexedDB 桩）；B：`_mbInjectable` 纯函数表驱动；C：默认值不变 |
| `tests/test_middle_brain_trace.js` | 追加 E（local 回落：零 Astra 请求 + 替换注入进请求体）、F（provider 中立性）；C 段补 `source: bypass` |
| `tests/test_middle_brain_seam.js` | B3/B4 改为 local 注入契约（旧断言编码的是被修掉的语义） |
| `tests/test_middle_brain_collapse.js` | H6 改为"徽标跟随 runtime，不跟随编辑态 toggle" |
| `tests/test_context_convergence_c1.js` | 用例 15 改为"Astra 失败 → local 回落同样替换注入" |
| `tests/test_frontend_structure.js` | `middleBrain.localNoInject` → `injectContractNamed` / `injectContractUsed` / `noTruthySource` / `badgeFollowsRuntime` / `toggleOnlyDirty` |
| `tests/test-all.js` | 登记两个测试（static：semantics；browser：trace） |
| `docs/history/runtime/P11-3-MIDDLE-BRAIN-SEMANTICS-CLOSURE.md` | 本报告 |

> 上一阶段（P11 audit）的 dev-only `[MiddleBrain Trace]` 观测层与本阶段改动落在同一批文件里，
> 且本阶段的验收证据就来自该 trace，因此同一次提交（提交信息中分层说明）。

---

## C. UI / runtime 新状态机

两套状态、两个来源、两条写入路径：

```
编辑态 (draft)                         runtime 态
  _mbUi.enabled                          apiSettings['middle_brain']
  #mb-endpoint.value                        └─ _mbRuntimeEnabled(c)  ← 唯一谓词
  #mb-apikey.value                       isMiddleBrainEnabled() / middleBrainExecute() 只读它
        │                                        ▲
        │ toggle/pick（不写存储）                 │
        └────────► _mbDirty() ──► _mbBadgeState() │
                     ▲                           │
   保存成功 ─────────┴───────────────────────────┘
   （_mbCaptureSaved(merged)：pristine 快照 + runtime 镜像同步刷新）
```

| 徽标 | 条件 | 文案 | class | title |
| --- | --- | --- | --- | --- |
| on | 无未保存改动 且 runtime 启用 | `Enabled` | `is-on` | `Runtime: Enabled` |
| off | 无未保存改动 且 runtime 关闭 | `Disabled` | — | `Runtime: Disabled` |
| unsaved | 有未保存改动（toggle / endpoint / API Key 任一） | `Unsaved` | `is-dirty` | `Runtime: <真值> · 有未保存的更改（点「保存 Middle Brain」后生效）` |

不变式（`tests/test_middle_brain_semantics.js` 逐条锁死）：

1. toggle 改动但未保存 → **零写入**（`dbWrites` 不含 `middle_brain`）、`isMiddleBrainEnabled()` **不变**、徽标**不得**是 `Enabled`。
2. 保存成功 → runtime 才改变，徽标回到 runtime 真值，`mb-save-status` 显示 `已保存`。
3. 重新 `loadMiddleBrainConfigUI()` → `toggle.checked` / 徽标 / `isMiddleBrainEnabled()` 三者一致、无 dirty。
4. `enabled:true` 但 endpoint 缺失 → 徽标 `Disabled`（runtime 确实没生效，不假装 Enabled）。
5. 全新安装 → `Disabled`、无 Unsaved。
6. 状态机符号全部留在 config 层内部：`MBC.config` 键集合不变（不扩公共 API），另加源码守卫 `toggleOnlyDirty`（toggle 事件里不得出现 `saveMiddleBrainConfig(` / `dbPut(`）。

---

## D. local fallback 新 contract

注入来源收敛为**具名三态**，判定集中在 `communication.js` 的 `_mbInjectable(res, userMessage)`：

| source | 含义 | 处理 |
| --- | --- | --- |
| `astra` | Astra 处理结果（唯一网络边界成功） | 替换原四块（当前消息缺失时由 pipeline 兜底追加） |
| `local` | 本地 pipeline 处理结果（Gate NO / Astra 未就绪 / Astra 失败） | 替换原四块 |
| `bypass` | 未启用 / seam 返回 `null` / 无产物 | 保留原始四块 |

允许注入的**必要条件**（任一不成立即 bypass，禁止"近似注入"）：

1. 来源显式具名（`'astra'` / `'local'` 白名单，**不得**把 source 判成 truthy）；
2. payload 是 trim 后非空字符串；
3. `stats.empty !== true`（本层真的组织过上下文）。否则 `compressedContext` 只是"全空兜底"把当前用户消息回声一遍，注入它只会给请求加一段无信息重复块，而且会**替换掉**（此处为空的）原四块；
4. `local` 额外要求 payload 保留当前用户消息 —— 这是本地 pipeline 的输出契约（facade 的无损兜底），用它反证 payload 来自本轮上下文。
   `astra` **不加**这一条：Astra 成功路径行为在本阶段保持不变。

**为什么是"替换"而不是"追加"**：审计里 local 不注入的历史理由是*避免重复/歧义* —— local 的 payload 就是 tail 里那四个块的确定性表示，追加必然双份。替换同时消掉了这条理由，也让 astra / local 两条路径同构（同一处索引切片，`_ctxJoined` / `_ctxStart` 锚点复用）。

**已知未改动的属性（如实记录）**：local 压缩使用 policy 层自己的预算 `MB_CTX_DEFAULT_BUDGET = 2600`（只作用于 memory/understanding/threads/moments 四类，当前对话不参与省略）。当原四块合计超过该预算时，local 注入会比"原样保留"更短。本阶段**不改**这个预算：它是 policy 层的既有输出契约，也会影响 Admission Gate 的 `localCompressionRatio` 信号（改它会顺带改 Gate 判定）。

---

## E. turn lifecycle 审计结果（只读审计 + 设计，本阶段不接线）

### E.1 逐路径调用关系（实测，非推断）

| # | 路径 | 入口 | 进 MB seam？ | 重跑 Astra？ | 注入状态 |
| --- | --- | --- | --- | --- | --- |
| 1 | 普通单聊（非流式） | `sendChatMessage` 单聊分支 → `buildChatContext` → `_buildSingleChatContext` | 是，**每请求 1 次** | 否 | astra / local 替换 |
| 2 | 流式单聊 | 同一 `_buildSingleChatContext`，executor = `callApiChatStream` | 是，同一个调用点 | 否 | 同上 |
| 3 | tool continuation | `_wsToolContinue`（`communication.js:3011`）→ 直接 `callApiChat(cfg,msgs,…)` | **否** | 否 | **复用**主轮 `messages`（`(o.messages||[]).slice()`）→ 主轮已注入的 MB 块原样带过去 |
| 4 | continue truncated | `continueTruncatedMsg`（`workspace.js:969`）→ 自建 msgs（system = 角色 system + WS 指令 / assistant = 旧文 / user = 续写提示） | **否** | 否 | **无任何上下文块**（也没有 Memory / Understanding / Thread / Moments） |
| 5 | voice（语音消息 / voice call） | `communication/call.js:440` / `voice.js:419` → `sendChatMessage({voiceCall:…})` → 单聊分支 | 是 | 否 | 同单聊；acoustic reference 由 `call.js` 追加在 MB 注入**之后**，与 MB 无交互 |
| 6 | group chat | `sendChatMessage` 的 `isGroup` 分支 → `_buildGroupChatContext` | **否** | 否 | 群聊完全没有 MB |

### E.2 结论："per request 还是 per conversational turn？"

- **MB preprocess 应该（且当前事实上）是 per conversational turn 的。** 依据不是"每请求跑一次也行"，而是：
  preprocess 的产物是**上下文**，而上下文在一次用户 turn 内不因 executor 数量而改变；同一 turn 的多次 executor 请求共享同一份 messages 语义。
- **当前实现已经是 turn-scoped，但是"隐式"的**：`_wsToolContinue` 不重建 context，而是复用主轮 messages，所以主轮注入的 MB 块自动被续轮继承；`continueTruncatedMsg` 与 group 根本不接 seam。三条路径都**不会**出现重复。
- **风险**：这份 turn-scoped 性质没有任何契约保护。一旦（"顺手迁移"）把 MB 接进 `_wsToolContinue` 或 `continueTruncatedMsg`，就会立刻退化成 per-request，并出现下列 5 种放大：

| 若 tool continuation 重新调用 `middleBrainExecute` | 后果 |
| --- | --- |
| Astra 重复调用 | 每次工具续一轮 1 次网络往返；链式工具（生成→调整→再调整）会叠成 N 次 |
| context 重复压缩 | 同一批四块被重复组织/压缩；`_mbAnalyzeSignals` 的本地压缩也会再算一遍 |
| tail 重复注入 | 续轮 msgs 里**没有** `_ctxStart` / `_ctxJoined` 锚点，只能"追加" → 主轮 MB 块 + 续轮 MB 块双份，且两份内容不同 |
| token / latency 放大 | 每次 Astra（含 Judge 时 2 次）+ 上下文体积重复 |
| semantic drift | 同一 turn 内两套"Astra 压缩后的上下文"并存，互相矛盾，且后者基于的结果已包含前者的影响 |

### E.3 最小 turn-scoped contract（设计，未实施）

```
MBTurnContext {
  turnId,            // 本轮唯一 id；现有锚点：voice 已带 callSessionId/turnId，IBContextSnapshot 已接受 turnId
  characterId,
  source,            // 'astra' | 'local' | 'bypass'
  processedContext,  // 可直接注入的 payload（已过注入契约）
  tail,              // 注入后的 tail（或注入块本身）
  createdAt
}
```

规则（最小）：

1. **一次 turn 只解析一次**：`middleBrainExecute` 由 turn 的第一个 executor 请求触发；结果写入 turn 级 cache（键 = `turnId` + `characterId`）。
2. **同 turn 内后续 executor 请求一律复用**（tool continuation、truncated continuation、自动续写轮）：命中 cache → 直接用 `processedContext` / `tail`，**不得**再进 Astra。
3. **失效条件**（任一即失效，只能重新解析）：用户发出新的 turn；characterId 变化；MB 配置在 turn 中途变更（persisted enabled / endpoint / model / apiKey 任一变化）；turn 显式结束。
4. **不落盘**：MBTurnContext 与 `MB_GATE_STATE` 同级（纯内存），turn 结束即丢。不新建第二套存储。
5. **群聊不复用单聊规则**：群聊的 persona / 成员身份 / 群记忆契约不同（见 §F），接入前需单独设计。

**为什么本阶段不实施**：它要引入 turn 身份（`buildChatContext` 目前连 `opts.turnId` 都没传，snapshot 的 `turnId` 恒为 `''`）、一个跨 executor 的内存 cache 及其失效逻辑，并把 `_wsToolContinue` / `continueTruncatedMsg` 纳入 seam —— 属于**架构改动**，不是语义修复。按本阶段要求"若需要较大架构改动，只给设计，不实施"。

---

## F. consumer scope matrix

| consumer | 现状 | 目标语义 | 判定 |
| --- | --- | --- | --- |
| 普通单聊（非流式） | 每请求 1 次 seam；astra / local 替换注入 | 每 turn 必须有一次 MB preprocess | **REQUIRED** |
| 流式单聊（`callApiChatStream`） | 与单聊**同一个**调用点（executor 不同） | 同上，且不得新增第二个调用点 | **REQUIRED** |
| tool continuation（`_wsToolContinue`） | 不调 seam；复用主轮 messages → 主轮 MB 块随行 | 同一 turn 内复用主轮 MB context，**禁止**重跑 Astra | **REUSE** |
| continue truncated（`continueTruncatedMsg`） | 不调 seam；自建极小 prompt，无任何上下文块 | 需先定义"续写是否属于同一 turn / 是否应带上下文 / 带哪一份" → 未定义前不得接线 | **NEEDS DESIGN** |
| voice（语音消息 / voice call） | 走单聊分支 → 已在 seam 上 | 与单聊一致 | **REQUIRED**（已满足） |
| group chat | `_buildGroupChatContext` 无 MB | 群聊 context 契约（成员身份 / 群记忆 / 多人发言规则 / 跨成员可见性）与单聊不同 → **禁止直接复用单聊逻辑** | **NOT APPLICABLE**（当前实现）/ **NEEDS DESIGN**（若要接入） |

---

## G. 测试结果

| 测试 | 结果 |
| --- | --- |
| `node tests/test_middle_brain_semantics.js`（新） | **21 项全通过**（A1–A13 UI/runtime 状态机；B1–B5 注入契约表驱动 + trace 三态；C1–C3 默认值不变） |
| `node tests/test_middle_brain_trace.js` | **38 项全通过、0 failed**（A/B/C/D 原有 + C7 `source: bypass` + E1–E9 local 回落 + F1–F3 provider 中立性） |
| `node tests/test_middle_brain_seam.js` | 0 failed（B3/B4 已改为 local 注入契约） |
| `node tests/test_middle_brain_collapse.js` | 全部通过（H6 = 徽标跟随 runtime） |
| `node tests/test_middle_brain.js` / `_admission` / `_astral` / `_ctx` / `_judge` / `_integrity` / `_advanced` / `_calibration` | 全通过 |
| `node tests/test_frontend_structure.js` | passed ✔（含 P11-3 新增 5 条守卫 + BOM/编码/公共 API/兼容符号守卫） |
| `node tests/test_context_convergence_c1.js` | 0 failed（用例 15 改为 local 替换注入） |
| `node tests/test_context_snapshot.js` | 0 failed |
| `node tests/test_chat_smoke.js` / `test_cache_audit.js` / `test_cache_audit_isolation.js` / `test_image_router_smoke.js` / `test_runtime_browser_audit.js` / `test_boot_smoke.js` | 全通过 |
| `node tests/test-all.js --quick` | **static 55 项 + service 16 项 全部通过**（200.1s） |

验收对照：

1. UI 不再出现假 Enabled ✔（`A3` / `H6`）
2. persisted enabled 与 runtime enabled 一致（单一谓词 + reload 一致）✔（`A6/A8/A9`、`A13`）
3. local fallback 注入后 mock 端点能看到 local context ✔（`E5`：请求体含 `Middle Brain 压缩后的上下文` + `【记忆】`；`E7` 证明是替换）
4. Astra 成功路径不变 ✔（`B9/B10`、seam `B5`、c1 的 astra 替换断言）
5. disabled 路径保持真正 bypass ✔（`C5`、`C7`、seam `B1/B2`）
6. Judge / OOC Guard 默认值不变 ✔（`C1/C2` + `test_frontend_structure.js` 既有守卫）
7. deepseek / OpenAI-format 无 provider 特判 ✔（`F1–F3`，含注入契约内不得出现 provider 关键词的源码守卫）
8. 原 Runtime Trace 测试继续全绿 ✔
9. 不扩 Middle Brain public API ✔（`A12`；`middleBrain.publicApiOwnership` / `keyShape` / `facadeOnlySetStable` 均未变，`_mbInjectable` 留在 communication.js IIFE 内）
10. 未迁移 Group / Tool / Continue ✔（仅 §E/§F 出报告与设计）

---

## H. git diff / commit

- 变更文件与提交见仓库提交记录（提交信息含本阶段 ID 与分层说明）。
- 变更面：12 个文件 · +964 / −36（3 个新增文件）。

```
 assets/css/core.css                                  |   3 +
 assets/js/communication.js                           |  90 +-
 assets/js/middle-brain-config.js                     |  90 +-
 assets/js/middle-brain.js                            | 108 +-
 tests/test-all.js                                    |   5 +
 tests/test_context_convergence_c1.js                 |  28 +-
 tests/test_frontend_structure.js                     |  26 +-
 tests/test_middle_brain_collapse.js                  |  28 +-
 tests/test_middle_brain_seam.js                      |  11 +-
 tests/test_middle_brain_semantics.js                 | new
 tests/test_middle_brain_trace.js                     | new
 docs/history/runtime/P11-3-MIDDLE-BRAIN-SEMANTICS-CLOSURE.md | new
```
- 上一阶段的 dev-only trace 观测层与本阶段改动同批提交：本阶段的验收证据本身来自该 trace，
  且 `middle-brain.js` / `communication.js` 两处的 hunk 相互交错，无法干净拆分。
- 本阶段**未**触碰：`middle-brain-policy.js`、`middle-brain-astra.js`、`middle-brain-judge.js`、
  `middle-brain-integrity.js`、`InternalBeyond.html`（无 HTML 结构改动 → 无需 `scripts_check_html.js` 变更）、
  Group / Tool / Continue 三条路径。
