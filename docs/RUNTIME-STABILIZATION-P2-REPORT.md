# InternalBeyond · Runtime Stabilization P2 · Contract Closure 报告

阶段：P2（Contract Closure）。目标：清理会阻碍 Runtime Convergence 的剩余 P2；不做 Runtime 全量统一、不新增功能、不做无关重构。
基准：工作区当前状态（P1 修复已在工作区，未提交）。本次未提交 Git。

---

## 1. 每项 P2 的根因与修复

### A. P2-01 语音重连在握手前断开时 Promise 永久悬挂

**根因**（`assets/js/communication/call.js`）
`connect()` 用 `settled` 标记"已结束"，但握手前断线时对重连分支的处理是
`if(!settled){settled=true; if(!isReconnect) reject(...); else return}`——
重连分支置位后**直接 return，既不 resolve 也不 reject**。于是：
- `await self.connect(true)` 永久 pending → `scheduleReconnect` 的 `catch` 永不执行 → 退避重试链断裂；
- `reconnectAttempts` 不复位、状态停在 `connecting`，调用方无法区分"正在重连"和"已经死了"。

**修复**
- 引入 `handshake` 标志（唯一判据是收到 `hello_ack`）：握手前任何 `onclose`/`onerror` 一律 settle 为 reject。
- 结构化终止语义：`error.voiceKind ∈ {connect, handshake, cancelled}`、`error.voiceCancelled`。
  - `connect`：首次连接握手前失败 → 调用方上报；
  - `handshake`：重连握手前失败 → 由 `scheduleReconnect` 的 catch 继续退避；
  - `cancelled`：用户已挂断/已销毁 → 调用方必须停止，`scheduleReconnect` 不再重试。
- `hello_ack` 到达时若已挂断 → reject cancelled 且**不发送 `start`**（避免已结束的通话重新握手）。
- 只有 `onerror` 不派发 `onclose` 的对端同样能结束（原先重连分支会挂住）。

**测试**：新增 `test_voice_reconnect.js`（11 项）覆盖四条路径（握手前断线／重连成功／重连失败／主动挂断）+ 只有 onerror + 退避 1s/2s + `VS_MAX_RECONNECT` 终止 + 挂断后不再调度。

### B. P2-02 Opt-in Runtime 契约（保持 opt-in）

**根因**（`assets/js/agent-runtime.js` 等）
1. **format 判定错误**：用 `has()`（只判 `typeof === 'function'`）检查 `IBModelCore` 与 `PROVIDERS` 两个**对象** → 条件恒假 → `anthropic`/`gemini` 静默回落 `openai`。
2. **budget 丢失**：默认 ModelPort 重建 `cfg` 时未带 `maxTokens`，也没有把 `request.budget` 传给执行器。
3. **loadContext 空转**：`run()` 读了 `ctx` 却从未编进 `request.messages`（身份/上下文编译是隐式债务）。
4. **abort 不完整**：非流式执行器 `callApiChat` 不读 `abortController`；且外部中止会被执行器归类为 `timeout`（误导）。
5. **usage 恒 null**：执行器把计量写进缓存审计，从不回传；`assets/js/bridge.js` 的 `_tkRecord` 包装器还吞掉了第三个参数。

**修复**
1. 新增 `_providerTable()` + `resolveProviderFormat()`：按对象存在性取目录（IBModelCore → PROVIDERS_DIR → PROVIDERS），ModelSpec 增加 `formatKnown` / `formatSource`；未知 provider 才回落 openai，且如实标记 `formatKnown=false`（不再"静默"）。
2. `request.budget` 落地：`resolveBudget()` 定义优先级 `input > cfg > executor-default`；非 null 时作为执行器 `maxTokens` 传入。
3. 新增端口 `composeMessages(agent, ctx, input)`：把 identity（= systemPrompt）、relationship、chatSummary、最近 12 条历史与调用方消息编成 `{system, messages}`；`run()` 使用它，并在结果中返回 `system` / `budget` / `usage` / `abortMode`。
4. abort 契约显式化：`mode='native'`（流式，真正取消）／`'abandon'`（非流式，竞速让 Promise 及时结束并放弃在途请求，不谎称已取消）／`'none'`；中止时 `aborted=true`、`text=''`、已产出文本放 `partialText`；桥接 `_st.abortReason='user_stop'` 使执行器归类为 abort 而非 timeout。
5. usage 契约：`_tkRecord(cfg, u, opts)` 可选回传 → `opts.result.usage` → ModelPort 归一为 `{input_tokens,output_tokens,total_tokens,cached_tokens}`，并带 `usageSource`；`bridge.js` 包装器改为透传全部参数。

**测试**：新增 `test_runtime_optin_smoke.js`（11 项）：三协议真实 wire（anthropic system/messages、gemini contents/system_instruction、openai messages）+ budget 生效 + usage 按各协议真实口径归一 + abort 三态 + `loadContext`/`composeMessages` 契约 + **生产 Chat 一轮后 `runtime.run/execute` 计数为 0**（opt-in 未被迁移）。

### C. P2-05 Consolidation 水位与 provenance + 历史修复

**根因**（`assets/js/active-diary.js`）
1. **水位只读不写**：`recentEpi` 用 `lastConsolidatedAt` 过滤，但成功后从不回写 → 同一批 episodic 永远"未固化"，被反复重做。
2. **顺序不确定**：`dbGetAll('memories'/'moments'/'diary_entries')` 后直接 `slice(-N)`，没有按真实时间排序。
3. **provenance 不可靠**：prompt 不提供真实来源 id 却允许模型返回 `consolidatedFrom`；空数组不回退 → 空 provenance 或幻觉 id。
4. **附带发现（同一可见性链路）**：`memory.js::quickCreateMemory` 把 `visibleTo`/`excludeFrom` 写死为空数组 → `visibility:'only'` 的记忆对**所有人（含作者角色）**不可见；影响 `activity-runtime.js:162` 的活动记忆与 consolidation 派生记忆。

**修复**
1. 水位回写：`_markConsolidated()` 在 merge/新建成功后对本次来源 episodic 做 read-modify-write 的 `lastConsolidatedAt`。
2. 真实时间排序：`_tsOf`/`_epiTime` 按 `created`（缺失回落 `lastActivated`/`lastConsolidatedAt`）升序取最近 12 条；moments 按 `createdAt`、diary 按 `created|date` 升序取最近 N 条。
3. provenance：prompt 每条来源前缀 `[id=...]`；模型返回的 id 只保留**真实存在**的来源，空/全无效 → 回退到本次实际来源。
4. `quickCreateMemory` 保留 `visibleTo`/`excludeFrom`（缺省仍为 `[]`，既有调用方行为不变）。
5. 保守修复流程（`_memRepairPlan` / `_memRepairApply`，浏览器侧）：
   - 只处理两类可判定记录：`semantic-broadened`（可见范围宽于 provenance 来源 → 收窄到来源派生范围）、`diary-missing-visibility`（缺 visibility 的旧日记记忆 → `only` + `visibleTo:[characterId]`）；
   - **只收窄、绝不放宽**：`_memRepairNarrower()` 要求严格更窄（同 rank 时受众集合真子集）；
   - **幂等**：apply 前按库内当前状态复核，已修复记录不再出现在下一次 plan；
   - **dry-run 优先**：`_memRepairPlan()` 只读，返回 `{scanned, repairs[], report{semanticBroadened, diaryMissingVisibility, unresolvedProvenance, onlyEmptyVisibleTo}}`；
   - 不可判定的（provenance 来源已消失、缺 characterId、`only` 但 visibleTo 为空）**只报告不修改**；
   - 不新建 store、不改 schema、不升 DB_VER（新增字段 `visibilityRepairedAt`/`visibilityRepairReason` 仅出现在被修改行上）。

**测试**：新增 `test_memory_repair_dryrun.js`（7 项：plan 只读、报告分类、apply 精确命中、逐字段"未放宽"、召回恢复、幂等、写入侧回归）；`test_memory_consolidation.js` 按真实语义更新并**加强**（水位标记、无新来源不重做、provenance 拒绝伪造 id、每个用例铺新来源并断言模型确实被调用）。

### D. P2-07 测试契约漂移（逐项核实后修测试或修生产）

| 项 | 核实结论 | 处理 |
|---|---|---|
| BOM | `assets/js/payment-settings.js`、`provider-directory.js` 缺 UTF-8 BOM（本仓库要求） | 补 BOM（`provider-directory.js` 补后 `require` 正常，15 个 provider） |
| inline budget | 实测 470 与提交状态一致；预算 460 是 6a61c3c 时期的陈旧值（此后 easteregg +10、backend-restart +1、HTML +3 均与本阶段无关） | 预算改为 **470 棘轮**（只能持平/下降），并写明来源；未删任何生产样式 |
| ModelCore require guard | 目录提取后 `ib-model-core.js` 合法 `require('./provider-directory.js')`，旧断言"零 require"过时 | 改为**白名单**（仅允许纯 metadata 模块）+ 新增 provider-directory 自身的 5 条边界断言 → 守卫更严 |
| DB_VER | 源码 `DB_VER=23`，`activities`/`favorites` 自 v21 存在 | 断言改为 `DB_VER>=21 && store 存在`（写死版本只会在每次升版误报） |
| worklet race | `IB.voiceCall` 由 `call.js` 挂载，晚于 page-ready 条件成立；单次 evaluate 会撞加载竞态 | 改为 `waitFor` 等待挂载（不是删断言） |
| Moments `local_user` | 生产权限按 `c.authorId===_activeUserId()`；测试写死 `'local_user'` 只在回退分支成立 | 测试改用 `_activeUserId()`，并**新增**权限负例（他人评论不可被删） |
| force/wantImage | `c15e7fb` 起 `forceImage:true`（手动"立即发布并配图"）明确跳过 wantImage 判断 | 旧用例改走自然判断路径；**新增** `ai.forceImageOverridesWant` 锁定新语义；phase4 C 同步 |
| provider-contract CORS/断言 | mock 的 `Allow-Headers` 未列 Anthropic 实际请求头；断言前未等请求到达 | 补全 CORS 头 + 新增 `waitCaptured()` 等待分支请求后再断言 |
| 测试入口遗漏 | `test-all.js --all` 只含 49 个脚本，仓库实有 86 个 | 全部登记（static 31 / service 16 / browser 40），分类规则写入头部注释 |

**额外发现并修复的真实生产缺陷**（由 P2-07 的浏览器测试暴露）：`_momentsRenderFeed` 并发渲染竞态——`loadMomentsPage()` 不等待渲染，全表游标扫描（最多 4s 兜底）比按角色索引慢，旧渲染会覆盖新筛选结果（切到"私人日志"后锁占位卡被无筛选渲染冲掉）。修复：渲染序号 `_momentsRenderSeq`，await 之后只有最新一次允许写 DOM。

### E. P2-03 / P2-04（只读核实，未统一）

见 `docs/P2-CONTEXT-CONVERGENCE-AUDIT.md`。要点：
- **P2-03 仍存在**：`communication.js:1348` 先召回 Memory（含激活计数写库），`:1365` 又以**空 opts** 调 `middleBrainCompressPipeline`，`middle-brain.js:455-480` 因此**再次**读取 Memory/Understanding/Thread/Moments；`:1367` 把压缩结果**追加**而非替换 → 同轮同一事实出现两次、token 反而增加。pipeline 已支持 `opts.*Ctx` 直传，修复只需调用点，不需改 middle-brain。
- **P2-04 仍存在**：`roleLetterMemories` 在前台 Proactive/Moments 的 prompt 中存在（`active-diary.js:392`、`moments.js:492`），但两个 companion 快照（`moments.js:1457-1469`、`active-diary.js:1012`）与两个 Node prompt（`active/moments.js:165-214`、`active/model-client.js:126-185`）都没有该字段；Memory 存在两套召回实现（`getMemoryContext` vs `_activeRecentMemories`）；门控位（普通 Memory / Auto Memory / 话题 memoryEnabled）语义互不等价。可收敛字段清单见该文档 §2.4。

---

## 2. 测试变化

新增（3 个文件）：
- `test_voice_reconnect.js`（11 项，纯 Node）
- `test_runtime_optin_smoke.js`（11 项，CDP + mock provider）
- `test_memory_repair_dryrun.js`（7 项，CDP + 真实 IndexedDB）

修改（11 个文件）：
- `test_frontend_structure.js`：inline 预算 460 → 470（附来源说明，棘轮不放松）
- `test_harness_boundary.js`：require 守卫改为白名单 + provider-directory 边界断言（更严）
- `test_activity_smoke.js`：DB_VER 固定断言 → 版本下限 + store 存在
- `test_worklet_localhost.js`：voiceCall 挂载改为 waitFor（消除加载竞态）
- `test_moments_smoke.js`：评论作者改用 `_activeUserId()` + 新增删除权限负例
- `test_moments_phase2_smoke.js`：`ai.textOnly` 走自然判断 + 新增 `ai.forceImageOverridesWant`；`like.applyBounded` 改为与角色数量无关的不变量（每次 ≤max、两次不重复、总数=两次之和 ≤ eligible）
- `test_moments_phase4_smoke.js`：C 用例改走自然判断路径（force 语义由 phase2 覆盖）
- `test_chat_smoke_provider_contract.js`：CORS 头补全 + `waitCaptured()` 等待请求
- `test_memory_consolidation.js`：按水位/provenance 真实语义更新并加强（模型调用计数、伪造 id 拒绝、水位标记）
- `test-all.js`：登记全部测试脚本（原 49 → 现 87 项 = 86 个 `test_*.js` + `scripts_check_html.js`）
- `test_runtime_integration_audit.js`：call.js 片段边界随源码结构同步（`_voiceConnError` 纳入片段）；voice 检查的竞速窗口 50ms → 2s（只放宽"等待时间"，不放宽"必须 settle"的断言）
- `test_bridge.js`：gemini mock 捕获改为轮询等待 + 新增 `gemini.mockReceived`（原实现直接读快照，机器负载下会读到 null 并抛出 TypeError 而非明确失败）

生产代码变化（7 个文件）：`assets/js/communication/call.js`、`assets/js/agent-runtime.js`、`assets/js/active-diary.js`、`assets/js/memory.js`、`assets/js/moments.js`、`assets/js/communication.js`（usage 回传）、`assets/js/social.js`（`_tkRecord` 可选第三参）、`assets/js/bridge.js`（透传第三参）。

---

## 3. 是否存在历史数据修改

**没有。**
- 本阶段未对任何用户数据执行写入或迁移：所有浏览器测试使用独立临时 profile；修复流程 `_memRepairPlan/_memRepairApply` 默认 dry-run，只在测试库上执行过 apply。
- 未升 `DB_VER`、未新建 objectStore、未改写任何既有记录。
- 生产侧只有**向前生效**的行为修正：新写入的日记/活动/consolidation 记忆会带上正确的 `visibleTo`；归纳成功后来源 episodic 会写入 `lastConsolidatedAt`（可选字段，已有 schema）。
- 已有坏记录**尚未修复**，需要用户显式运行：`_memRepairPlan()` 查看报告 → 确认后 `_memRepairApply(plan)`。报告中的 `unresolvedProvenance` / `onlyEmptyVisibleTo` 两类只提示不修改。

---

## 4. 剩余红项

`node test-all.js --all`（最终运行）：**87 项全部通过**，退出码 0
（static 31 项 15.8s / service 16 项 81.8s / browser 40 项 316.9s，总耗时 414.5s）。无"大家都知道是旧测试"的红项。

附加验证（本阶段要求逐项执行）：
- Runtime Integration Audit：`node test_runtime_integration_audit.js` → 10/10 通过；
- localhost / file 双入口浏览器 smoke：`node test_runtime_browser_audit.js`（localhost）与 `--file`（file://）→ 均 5/5 通过，`IB.runtime.instance.run` 调用计数 0；
- Voice targeted regression：`test_voice_reconnect.js`(11) / `test_voice_runtime.js` / `test_voice_streaming.js` / `test_worklet_localhost.js` / `test_voice_capture_live.js` → 全通过；
- opt-in Runtime 三协议 smoke：`test_runtime_optin_smoke.js` → 11/11 通过；
- Memory repair dry-run validation：`test_memory_repair_dryrun.js` → 7/7 通过（plan 只读、只收窄、幂等）。

仍**未进入 `--all`** 的项（外部依赖，非测试逻辑问题）：
- `python test_vision.py`：需要 Python 环境 + `test.jpg` + 本地 Vision 服务 `127.0.0.1:8765`；本次 health 探测不可达，未执行、未声称通过。

非失败但保留的标记：
- `test_model_core_contract.js`：8 条 WARN（现有实现 vs IBModelCore 的 5 处语义差异 + 3 处 usage 字段缺口），按约定"仅报告不自动统一"。
- `test_harness_boundary.js`：3 条 `KNOWN P1`（`agent-runtime.loadContext/observe` 仍指向 Domain 符号），记录不判失败。

运行期已消除的两处**测试自身**不稳定（非产品缺陷，均已核实 10+ 次单独运行通过、只在整机负载下偶发）：
- `test_bridge.js` gemini mock 捕获快照在断言前未就绪 → 改为轮询等待并新增 `gemini.mockReceived`；
- `test_runtime_integration_audit.js` 的 50ms 竞速窗口 → 放宽到 2s（"必须 settle"的断言不变）。

---

## 5. 是否满足启动 Runtime Convergence Phase 1

**满足启动条件，但带 3 个前置约束。**
- 契约层已闭环：ModelSpec（format/formatKnown/budget/identity）、execute（abort/usage/partialText）、loadContext/composeMessages 都有可执行断言，且 `IB.runtime` 仍未被生产调用（browser audit 与 optin smoke 均计数为 0）。
- 前置约束：
  1. **先修 P2-03 重复检索**（或把"单聊迁移"与它合并处理），否则会把"读两次 + 追加压缩"一起搬进 Runtime；
  2. **先定 P2-04 的产品语义**（`roleLetterMemories` 是否进 companion、门控位如何表达），再谈上下文统一；
  3. **迁移方式必须分两步**：先只迁移"执行接缝"（`execute`），暂不迁移 `loadContext/composeMessages`（后者会改变上下文内容）。
- 明确不迁移：Voice/TTS/ASR（职责分离，不需要经过 Runtime）、Middle Brain（独立协调层）、Node companion（`callCharacterModel → NodeModelPort` 是另一条 runtime 通道，需单独收敛）。

---

## 6. 推荐第一个迁移到统一 Runtime 的生产 consumer

**浏览器 Active 主动消息生成 `generateProactiveMessage`（`assets/js/active-diary.js:404-421`）。**

理由：
- 已经是**单次、非流式、无工具、无 autoContinue** 的调用（`requestModel` 默认即 `callApiChat`），与 ModelPort 的能力边界完全吻合；迁移只需把 `requestModel(...)` 换成 `IB.runtime.instance.execute({spec, messages, budget}, {onEvent})`，触发器自己的校验/重试/fallback 循环保持不动。
- 它已经传 `result:{}`，因此新的 `usage` 契约立刻可用（可观测、可回归）。
- 失败已有兜底（`_activeFallbackMessage`），迁移回归的影响面有界。
- 有现成测试面：`test_active_diary_smoke.js`、`test_proactive_phase2.js`、`test_bgai_propagation.js`。
- 不触碰 P2-03 的 Middle Brain 重复检索路径，也不依赖 P2-04 未收敛的字段。

迁移边界（建议）：
1. 只替换执行调用，不替换 prompt 构建（`buildProactivePrompt` 与 `loadProactiveMessageContext` 保持原样）；
2. `spec` 由 `runtime.resolveModel(cfg)` 生成，`budget` 显式传 512（与原 `maxTokens:512` 一致）；
3. 保留原 `result.reasoning_content` 语义（Runtime 返回 `reasoning`），并新增断言"runtime 只被这一个触发器调用"；
4. 回滚开关：单点 if/else 保留 `callApiChat` 直调路径一个版本，便于对照。

备选（风险更高，不建议第一个做）：Diary/Consolidation（写记忆，错误代价高）、Moments 生成（依赖图片与事件回传链）。
