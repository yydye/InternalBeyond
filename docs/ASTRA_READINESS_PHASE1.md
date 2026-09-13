# Astra Readiness Phase 1 · Live Observation & Calibration Baseline

**状态：观测阶段已完成，真实模型观测被一个硬前置条件挡住（见 §2）。**
本阶段**零生产改动**，不调参、不启用 Astra。

```
基线：M1-C.2n / M1-C.2o / M1-C.2p 全部 CLOSED；FULL SAME EVIDENCE 已达成（memory / threads /
      understanding / moments / dialogue）；commit 41b4b3f。
本阶段：建立"改了之后系统到底怎么表现"的可信真实模型证据之前所需的**全部前置**：
      可复现语料、可界定的调用预算、可证明无副作用的安全包络、以及只读基线测量。
      唯一没做到的是"真实模型观测"本身 —— 因为没有合法凭据（§2）。
```

---

## 1 · 结论摘要（先说最重要的四件事）

| # | 结论 | 类别 |
|---|---|---|
| 1 | **没有合法的实时凭据可用** → 本阶段**没有发起任何付费调用**，真实模型质量仍是 UNKNOWN | MEASURED |
| 2 | **现有的 "calibration" harness 并不是无副作用的**：校准页面在启动阶段会 `POST http://127.0.0.1:23118/memory/settings`，而这台机器上 23118 **确实在监听** —— 那是一次对真实本地服务的写。现已用 document-start 网络白名单**拒绝**（harness 级改动，未改生产） | MEASURED |
| 3 | `dlgCharsHigh = 3500` 在**只有历史**的情况下结构性不可达（历史上限 3228 字）→ dialogue 权重永远拿不满；而当前消息一旦长于 **273 字** 就能越线 | MEASURED |
| 4 | `multipleThreads`（一个**无视冷却**的硬触发）实际上等价于"理解块非空"或"存在 ≥1 条线索"：渲染器固定输出 3 行、线索块固定输出 标题+1 行，而触发判据数是**行数**≥2 | MEASURED |

---

## 2 · 凭据边界（本阶段的硬停点）

**事实**：`IB_CI_CALIBRATION_KEY` / `IB_CI_CALIBRATION_ENDPOINT` 两个环境变量在本机均为空，
仓库内没有任何地方给它们赋过具体值（逐文件扫描断言 `K1.noConcreteCalibrationSecretInRepo`），
harness 里唯一的读路径是 `process.env.IB_CI_CALIBRATION_KEY`（`K3`）。

**按 §2 的要求：没有合法凭据 → 不发真实调用、不发明凭据路径、不动凭据边界。**
逐条确认本阶段**没有**做这些事（也没有任何代码改动指向它们）：

- ✗ 没有把桌面 API Key 复制到 Home Node
- ✗ 没有在 Home Node 持久化任何 key
- ✗ 没有新增 mobile credential 动词
- ✗ 没有改 `/mobile/v1`
- ✗ 没有改配对流程
- ✗ 没有从 Android 隧道传凭据
- ✗ 没有以任何方式放宽凭据边界

**Home Node 侧的就绪谓词现状（只读复核，未改）**：适配层构造式产生的配置里 `apiKey` 恒为 `''`
（`services/home-node/middle-brain.js` → `getConfig()`），因此 `middleBrainReady()` 恒 false，
Admission Gate 恒 `astra_not_ready`，任何 Astra/Judge/Integrity 的网络调用在**发起之前**就被挡住。
实测：以 Home Node 配置调用 `middleBrainReady()` → `false`；`middleBrainAdmissionGate()` → `astra_not_ready`。

**缺什么（精确清单）**：

1. `IB_CI_CALIBRATION_KEY`（真实端点凭据）
2. `IB_CI_CALIBRATION_ENDPOINT`（真实端点 URL；不给的话凭据会被发往本地 mock，所以两者都必须有）
3. 可选 `IB_CI_CALIBRATION_MODEL`（不给就用 harness 默认；**本阶段不擅自指定模型**）

**并且**：显式 `--live` 但凭据不齐时，harness 现在会 **exit 3 中止**，而不是静默降级成离线 mock
（静默降级会让 mock 数据被当成真实模型观测 —— 而这一阶段存在的唯一理由就是区分这两者）。

---

## 3 · 架构（只读重建）

### 3.1 Astra 在哪里被关着

| 关口 | 位置 | 语义 |
|---|---|---|
| ① 默认关闭 | `middle-brain-config-core.MB_DEFAULTS.characterIntegrityEnabled = false` | Guard 关闭时**零模型调用**，行为与 P11-1C 等价 |
| ② 就绪谓词 | `middleBrainApiReady(c) = enabled && endpoint && model && apiKey` | 四个都非空才算"可用"；**就绪≠启用** |
| ③ Guard 早退 | `middle-brain-integrity.js`：`if (!(await CFG.middleBrainReady())) { _ciSkip('astra_not_ready'); return out; }` | 在组装证据、构造 prompt **之前**就返回 |
| ④ Admission Gate | `middle-brain-policy.middleBrainAdmissionGate()`：未就绪直接 `{useAstra:false, reason:'astra_not_ready'}` | 认知层的省钱闸门，先于任何压缩/调用 |
| ⑤ Home Node | `services/home-node/middle-brain.js`：`merged.apiKey = ''` | **结构性**（不是纪律性）不可达：凭据根本没进这个进程 |

`MB_DEFAULTS` 里与本阶段相关的开关：`admissionEnabled: true`、`middleBrainJudgeEnabled: false`、
`characterIntegrityEnabled: false`、`characterIntegritySensitivity: 'conservative'`、
`characterIntegrityRewrite: false`、`characterIntegrityVerify: false`。
**本阶段一个都没改。**

### 3.2 Character Integrity 的可配置面（本阶段全部冻结）

- 灵敏度阈值（`MB_CI_SENSITIVITY`）：conservative `{confidence 0.80, score 0.35, severity 0.85, failBelow 0.50}`、
  balanced `{0.65, 0.45, 0.70, 0.60}`、strict `{0.50, 0.55, 0.60, 0.70}`
- 维度白名单：`persona / speech_style / relationship / emotional_continuity / knowledge_boundary / behavior`
- 上限：`MB_CI_MAX_VIOLATIONS 8`、evidence/reason 各 200 字、judge 900 tok、rewrite 1600 tok、超时 20s
- 门控顺序（`.middle-brain-integrity._mbCiGate`，顺序即语义）：
  `no_report → judge_pass → rewrite_disabled → rewrite_already_used → control_tags_present → low_confidence → score_above_threshold → severity_below_threshold → strong_ooc`
- 每轮硬不变量：**最多 1 次 judge、最多 1 次 rewrite、verify 只观测、任何失败回原候选**

### 3.3 校准 harness 的两层结构（本阶段扩写后）

| 层 | 文件 | 跑什么 | 网络 |
|---|---|---|---|
| Layer A | `tests/test_middle_brain_calibration.js` + `tests/middle-brain-calibration.js` | 指标/契约正确性（confusion、gate 等价、边界、无证据保护、零污染） | 零 |
| Layer B | `tests/test_middle_brain_calibration_live.js` | 真实执行路径（真实 judge prompt → 真实传输 → 真实解析 → 真实 gate） | 默认本机 mock |
| 观测器 | `tests/astra-observation.js` | §4 schema、预算、脱敏、judge/rewrite/verify 分开度量 | 零 |
| 语料 | `tests/astra-readiness-corpus.js` | A–U 观测类别语料（38 条，**不含任何模型输出**） | 零 |

`--live` 到底执行什么（逐条回答 §1 的 16 个问题）：

| 问题 | 答案 |
|---|---|
| 用真实 judge 吗 | **是** —— 真实 `_mbCiJudgePrompt` 构建 + 真实 ASTRA 传输 + 真实 `_mbParseCiJson` |
| 执行 rewrite 吗 | 默认**不执行**（`characterIntegrityRewrite:false`，detect-only）；`--rewrite` 才执行 |
| 执行 verify 吗 | 默认**不执行**；`--verify`（需同时 `--rewrite`）才执行 |
| 会改生产状态吗 | **不会**（临时 profile + 平台层绊线 + 网络白名单，见 §4） |
| 会写 memory/moments/understanding/thread/message/telemetry/config/gate state 吗 | **不会**（同上，逐条断言 T3–T10） |
| 花真钱吗 | 只有 `--live` 会；本阶段**没有**发生 |
| 会向 Home Node 暴露 key 吗 | 不会；Home Node 结构性不持有凭据（§2） |
| 哪个宿主发真实请求 | **桌面**（isolated headless Chrome 的页面上下文，走生产 `_mbApiPost`） |
| 模型看到什么证据 | 生产 `_mbCiBuildEvidence` 的输出：角色证据（昵称/关系/简介/systemPrompt(≤1600)）+ canonical 对话行（共享核心投影，guard 消费预算 2400）+ 可用上下文证据（四类各 ≤900）+ 当前用户消息（≤600）+ 候选回复 |
| 保留什么输出 | 判定结构（pass/score/confidence/maxSeverity/dimensions/violations 的维度与长度）、延迟、usage、状态、rewrite 前后长度比与 ≤60 字片段 |
| 已经采集的指标 | Layer A 的全部指标（confusion/FPR/FNR/dimension confusion/boundary/sensitivity 模拟） |
| 缺的指标 | **真实模型的判定**（因为没跑）；rewrite 的语义质量（只能给出确定性契约代理）；verify 的真实接受/拒绝分布 |
| 观测能否无副作用 | **现在可以**（本阶段的 harness 改动使它成立）；**本阶段之前不能**（见 §4.1） |

---

## 4 · 观测的无副作用性（本阶段最重要的工程成果）

### 4.1 发现的缺陷：现有的 "calibration" 会写真实本地服务

用 document-start 注入的守卫记录下来的**页面启动期**请求（在观测窗口之前，因此原实现会真的发出去）：

```
GET  127.0.0.1:23118/memory/list           ← 读真实本地 Home Node 的记忆
GET  127.0.0.1:23118/list
GET  127.0.0.1:23115/health
GET  127.0.0.1:23115/api/context
GET  127.0.0.1:23118/understanding/list
GET  127.0.0.1:23118/moments/list
POST 127.0.0.1:23118/memory/settings        ← ★ 写：把桌面记忆预算发布给 Home Node
```

`POST /memory/settings` 的调用链是
`home-node-bootstrap.publishMemorySettings` → `memory-authority.publishSettings` → `home-node-client.putSettings`。
TCP 连接性探测（只连不发包）显示本机 **23114 / 23115 / 23116 / 23118 四个端口都在监听** ——
也就是说这次 POST 会打到**真实运行的本地服务**，并把桌面（临时 profile 的）默认记忆预算写进去。

**这是本阶段按 §0/§11 该停下来报告、而不是顺手"修好"的东西。**
它属于 harness 层面的安全缺口，不是生产缺陷，所以修在 harness 里：

### 4.2 修法：document-start 网络白名单守卫（只改 harness）

在 `Page.addScriptToEvaluateOnNewDocument` 注入（因此**早于页面任何脚本**）：

- **白名单**：只允许校准页面自己的页面服务器 + 本机 mock 端点（`--live` 时再加真实端点 host）
- **拒绝方式**：白名单外的 `fetch` 返回**合成 403**（一个字节都不发出去）；`XHR.send` 直接 `abort()`；
  `navigator.sendBeacon` 返回 `false`；`WebSocket` **只记录不拒绝**（拒绝可能让页面启动失败，
  而连接本身不是写），校准窗口内应为 0
- **全部尝试都记进 `denied` 清单**并在报告里打印，绝不静默吞掉

### 4.3 两层绊线（"没有写盘"的证据）

- **平台层**（强证据）：`IDBObjectStore.prototype.{put,add,delete,clear}`、`Storage.prototype.{setItem,removeItem,clear}`、
  `XMLHttpRequest.prototype.send`、`fetch`。**闭包直接调用也绕不过原型** —— 只包 `window.X` 是不够的
  （`core.js` 里 `window.dbPut = dbPut`，模块内部的调用走的是闭包引用）。
  每个绊线还记录 **store 名**（例如 `apiSettings` / `memories` / `moments`）。
- **语义层**（可读性）：`dbPut / dbDelete / saveMemory / deleteMemory / writeOneLineToMemory / createThread /
  createMoment / deleteMoment / middleware…` 等 21 个入口，用访问器在**赋值时**就包住，因此
  "第一次赋值"之后的所有调用都会被计数。

### 4.4 逐条安全断言（§12 T1–T16）

| 断言 | 内容 | 结果 |
|---|---|---|
| T1 | 有显式调用上限，实际 ≤ 预算 | PASS |
| T2 | 不会无限重试；实际 ≤ 事前声明的最坏情况 | PASS |
| T3 | 不能写聊天消息 | PASS |
| T4 | 不能写记忆 | PASS |
| T5 | 不能写理解 | PASS |
| T6 | 不能写线索 | PASS |
| T7 | 不能写动态 | PASS |
| T8 | 不能改 Middle Brain 配置（窗口内 `saveMiddleBrainConfig` = 0） | PASS |
| T9 | 不能改 gate 状态 | PASS |
| T10 | 不能写生产 provider 配置 | PASS |
| T11 | 日志/报告不出现凭据（离线也用哨兵值真的验一遍） | PASS |
| T12 | fixture id 确定性 | PASS |
| T13 | 期望标签与观测标签结构分离 | PASS |
| T14 | provider 错误如实记录（不编造 pass/fail） | PASS |
| T15 | 能干净中止；只联系白名单 host；无写请求 | PASS |
| T16 | 不削弱 FULL SAME EVIDENCE 契约 | PASS（见 §7） |

**这些断言在每一次回归里都会被执行**：同一个 harness 以 `--corpus=readiness --rewrite --verify`
离线跑一次（6 条样本、最坏 18 次本机 mock 调用）已经登记进 `test-all` 的 browser 组。

### 4.5 诚实标注的局限

守卫会**拒绝**校准页面上的站外请求，因此校准页面与"用户正常打开应用"并不完全同形。
这不影响被观测对象，理由是结构性的：Character Integrity **自己不检索任何东西** ——
它只消费调用方交进来的 `opts`（角色 / 历史 / currentId / contextSnapshot）。
断言 `X1.guardNeverRetrievesItself` 与 `X2.evidenceInputsAreExplicit` 把这一点钉在源码上。

---

## 5 · 语料（§3）

`tests/astra-readiness-corpus.js`：**38 条**确定性样本，覆盖 A–U **全部 21 个**观测类别（`C2`）。

- 每条都能直接喂进真实执行路径：角色 / 历史（canonical 行，可带 id）/ 当前消息 / 候选 / 四类上下文
- **不携带任何人工观测**：`observed` 恒为 `null`（`C3`），语料里禁止出现
  `observedJudge / judge / pass / score / confidence / violations` 任何键
- `expectation` 分两种**形态上不可混用**：
  - `kind:'judgement'` —— 人工判定（`ooc` 必为布尔 + 声明维度 + 是否该重写）
  - `kind:'contract'` —— 契约约束（**`ooc` 与 `rewriteExpected` 必须为 null**）：例如
    `no_dimension_without_evidence`（证据不可用的维度不得据此判 fail）、`verify_observes_only`
- `rewriteContract`：对"该重写"的样本声明 `mustPreserve`（事实/字段名必须留下）与
  `mustNotContain`（被指出的 violation 原文不得留下）—— 这是**确定性**的 rewrite 质量代理，
  不依赖模型自评
- 角色身份复用旧语料的 5 个**合成** PROFILES（`companion / builder / cold / technical / sparse`），
  不新建第二套身份

> 为什么不直接复用旧的 122 条：它们是按 **CI 判定类别**组织的、每条都带 authored `observedJudge`，
> 而且实测 history 字符数 min=0 / max=55 —— **整批都落在 dialogue 权重的最低档**，
> 根本压不动 Gate 的对话项（见 §6）。

---

## 6 · dialogue 字符数分布与 600 / 3500 边界（只测量，未改）

测量方式：在**真实生产装配**上（Home Node 的 canonical loader）对每条样本调用真实
`policy._mbAnalyzeSignals`，读它算出的 `dialogueChars`。

### 6.1 分布

| 语料 | n | min | p10 | p25 | median | p75 | p90 | p95 | max |
|---|---|---|---|---|---|---|---|---|---|
| 新 A–U 语料 | 38 | 5 | 9 | 20 | 30 | 41 | 102 | 1633 | **1715** |
| 旧 122 条语料 | 122 | 5 | 11 | 15 | 15 | 40 | 59 | 86 | **88** |

**分档**：新语料 35 条 `below_low`、3 条 `ramp`、0 条 `at_or_above_high`；
旧语料 **122/122 全部 `below_low`**（即 dialogue 分量恒为 0）。

### 6.2 结构性事实（决定性）

`dialogueChars` = 共享核心投影出的每一行（含 `用户：`/`角色：` 各 3 字标签）的长度之和。于是：

- **只有历史**时的上限 = 8 条 × (400 + 3) = **3224**；加上一句 1 字当前消息 = **3228**（实测 `B2`）
- 对应 `dlgScore = (3228 − 600) / (3500 − 600) = 0.906** —— 也就是说 **历史永远拿不满** dialogue 权重
- 要真正到达 `dlgCharsHigh`，**当前用户消息必须 ≥ 273 字**（实测 `B3`：3500 字当前消息 → 3503 → dlgScore = 1.0）

**含义（MEASURED）**：`dialogueChars` 在长输入下主要由**当前用户消息**驱动（它按共享核心的规则
**不截断**），而不是由"对话有多长"驱动。600/3500 这两个数字因此与"对话历史的长度"这件事
对齐得并不好：600 以下把绝大多数真实轮次压成 0 分，3500 又只有超长单条消息才够得到。

**本轮不改**（§0）。见 §8 的 RECOMMENDED。

---

## 7 · multipleThreads 触发分布与原因（只测量，未改）

触发式（`middle-brain-policy.js`）：`multipleThreads = (threadItems >= 2 || understandingItems >= 2)`，
其中 items 数的是**块里非空行的条数**（`countLines` 按 `/\n+/` 切分后统计非空行 —— **标题行也算一行**）。
语义上它是**无视冷却**的硬触发（在 state/cooldown 检查**之前** return）。

### 7.1 用真实渲染器测出来的形状

| producer | 渲染结果 | 非空行数 | items | multipleThreads |
|---|---|---|---|---|
| `renderUnderstandingContext(doc)`（理解文档存在） | `UNDERSTANDING_HEADER` + `- 维度：… · 置信：…% · 依据：N 条记忆` + `- <内容>` | **3**（固定） | `understandingItems = 3` | **true** |
| `buildThreadBlock()` 有 **1** 条线索 | `THREAD_HEADER` + `- <问题>（依据 N 条记忆）` | **2** | `threadItems = 2` | **true** |
| `buildThreadBlock()` 有 2 条线索 | 标题 + 2 行 | 3 | `threadItems = 3` | **true** |

实测（真实 `_mbAnalyzeSignals` + 真实 `_mbDecisionFromSignals`，warm state + 冷却中）：

```
understanding_real_block     understandingItems=3  contextChars=95  → gate=multiple_threads (useAstra=true)
thread_real_block_1_thread   threadItems=2         contextChars=59  → gate=multiple_threads (useAstra=true)
thread_real_block_2_threads  threadItems=3         contextChars=67  → gate=multiple_threads (useAstra=true)
```

**结论（MEASURED）**：

1. **理解块非空，就足以触发** —— 因为渲染形状固定 3 行，且判据数是行数不是"话题数"。
   这与"multiple threads"这个名字所声称的语义**不一致**。
2. **存在 1 条线索也足以触发** —— 标题行占掉一个 item，于是"标题 + 1 行"就是 2。
3. 激活发生在 `contextChars ≈ 60~95` 这种极小上下文上，且**无视冷却**（冷/热状态都是 YES）。
   叠加上"任一角色只要有活跃的理解文档"，新语料 **38/38** 条都会变 true（`M10`）。
4. 语料本身（单行上下文块）**0/38** 触发 —— 也就是说：**旧语料根本测不到这个触发**，
   只有把真实的 producer 渲染形状放进来才看得见。

**本轮不改**（§0）。见 §8 的 RECOMMENDED。

---

## 8 · MB_GATE_STATE 归属 / 生命周期 / 分叉（§8）

### 8.1 归属与生命周期（只读事实）

| 项 | 事实 |
|---|---|
| 声明 | `assets/js/middle-brain-policy.js`：`var MB_GATE_STATE = {}`（模块作用域，键为 characterId） |
| 生命周期 | **JS realm 存活期**：桌面 = 页面会话（**刷新即丢**）；Home Node = 进程存活期 |
| 持久化 | **不落盘**（该文件里没有 `dbPut / dbGet / localStorage / indexedDB / sessionStorage`，`G1`） |
| 重置 | 只有 `middleBrainAdmissionGateReset(characterId\|null)` 能清；**生产代码里没有任何调用点**（`G2`） |
| Home Node | 那张表**永远为空**：`middleBrainReady()` 恒 false → Gate 在读写状态**之前**就返回 `astra_not_ready`（`G5`） |
| 实际写入点 | `middleBrainAdmissionGate()` 每次判定都会 `state.lastMessageAt/lastDecision/lastDecisionAt/lastAstraAt` 并写回 |

### 8.2 确定性反例：同一份证据 → 不同判定

同一组 signals（`contextChars 4500 / dialogueChars 1500 / memory 2 / understanding 1 / thread 1 /
ratio 0.45 / 无冲突 / 无多线索 / 未接近预算`，加权分 **0.5821**）、同一个 `now`，只有宿主本地状态不同：

| 宿主本地状态 | 判定 | useAstra |
|---|---|---|
| 冷启动（无记录） | `simple_context` | **false** |
| 1 秒前 YES 过 | `hysteresis_hold` | **true** |
| 5 秒前打过 Astra | `cooldown` | false |
| 200 秒前 YES 过（迟滞窗口 180s 已过期） | `simple_context` | false |
| Home Node（恒空表） | `astra_not_ready` | false |

**同一份证据，冷启动与"刚 YES 过"给出相反的决定**（`G3`/`G4`）。再加一条：
桌面**刷新页面就丢状态**，于是完全相同的对话在刷新前后也可能得到不同判定；而 Home Node
因为凭据边界永远不会走到状态检查。**本轮不统一 gate state**（§0），这是留给下一个设计决策的证据。

---

## 9 · 真实模型质量（UNKNOWN）

本阶段**没有**真实模型观测数据，因此 judge / rewrite / verify 的真实质量全部是 **UNKNOWN**。
不把 mock 结果、Layer A 的 authored 记录、或任何推断写成"看起来还行"。

已经就位的观测能力（一旦有凭据即可产出）：

- **judge**：TP/TN/FP/FN、agreement/precision/recall/specificity、error/malformed/notRun、
  延迟分布、usage、逐条判定（pass/score/confidence/maxSeverity/dimensions）
- **rewrite**：触发/成功/失败（含失败原因分布）、是否真的改变、长度比、**契约违反**
  （丢事实 / 留下被指出的 violation）、`<0.5` 的"无必要变短"
- **verify**：是否触发/是否真的跑了/pass/fail/error、**是否接受了违反契约的重写**、
  **是否拒绝了满足契约的重写**、以及"同一样本 >1 次 rewrite"（必须为 0）
- **可重复性**：同一 fixture 多次运行的判定/维度/最终处置是否稳定（`--repeat=N`，上限 5）
- **成本/延迟**：judge-only / judge+rewrite / judge+rewrite+verify 三档分开统计；
  token 只报 token（**仓库内没有任何 provider 定价元数据，所以绝不硬编码价格**）
- **期望 vs 观测**：FP 候选 / FN 候选 / 歧义与证据不足样本 / 契约违反，四类分开列

离线（mock）跑通验证了这条管线**端到端可产出**这些数字（`--corpus=readiness --rewrite --verify`）：
6 条样本 → judge 6 / rewrite 6 / verify 6 次调用，usage 与延迟都被如实记录，
`provenance=mock(mock-driven)` 在报告里被显著标注。

---

## 10 · 计划 vs 实际调用数

| 运行 | 事前声明（最坏情况） | 实际 | 备注 |
|---|---|---|---|
| 本阶段全部离线运行 | ≤ 24（登记的回归跑）/ 18 | 18 | 全部打向本机 mock |
| **真实调用** | — | **0** | 无合法凭据 → 未发起 |

预算口径：`planned = cases × repeat × (1 + rewrite?1 + verify?1)`，上限 `min(--budget, 240)`；
**先打印、再比较，超预算在启动浏览器之前 exit 2**。为什么用最坏情况：Judge 会判几条 OOC
在跑之前是不知道的，用"期望估计"当预算是低估。

---

## 11 · 测试与回归

本阶段新增/改动：

- 新增 `tests/astra-readiness-corpus.js`（语料）
- 新增 `tests/astra-observation.js`（观测 schema / 预算 / 脱敏 / 指标）
- 新增 `tests/test_astra_readiness_observe.js`（static，只读观测：§6/§7/§8 + 零生产改动断言）
- 扩写 `tests/test_middle_brain_calibration_live.js`（预算、观测、绊线、网络守卫、安全包络 S/T）
- 登记 `tests/test-all.js`：新 static 测试 + 同一 harness 的 readiness 离线跑

复跑的冻结契约与结果见交付报告；**FULL SAME EVIDENCE 保持完整**。

---

## 12 · 建议（RECOMMENDED，**没有实现**）

按 §14 的要求，以下都只是建议，一行代码都没写：

1. **`dlgCharsHigh`（3500）与"对话长度"不对齐** —— 仅靠历史最高只能到 3228（dlgScore 0.906），
   而 3500 需要 ≥273 字的单条当前消息。候选方向（需单独阶段决策）：
   要么让"当前消息长度"从对话项里分离出去单独计权，要么按共享核心的实际上限重新校准这组数字。
   **不要**在没有真实分布的情况下直接改数字。
2. **`multipleThreads` 的判据与名字不符** —— 现在等价于"理解块非空 或 存在 ≥1 条线索"。
   候选方向：改为计**语义条目数**而不是行数（标题行不计），或把理解块与线索块分开判据。
   这是一个**无视冷却的硬触发**，影响的是成本与"是否真的值得一次语义整理"，不是正确性。
3. **`MB_GATE_STATE` 的宿主分叉** —— 同一份证据在冷/热/刷新后会给出相反判定，而 Home Node
   恒不参与。候选方向需要在"统一状态归属"与"明确接受宿主本地性"之间做一个设计决策，
   并同时决定"刷新即丢"是否可接受。
4. **是否可以让 Astra 进入受控启用实验** —— 现在**不能**：① 没有真实模型质量数据
   （judge/rewrite/verify 全 UNKNOWN）；② 本阶段才发现 harness 原先会写真实本地服务，
   虽然已修但说明"校准工具的安全性"此前是没有证据的；③ Home Node 侧仍结构性不可达。

---

## 13 · 数据分级（§14 要求）

### MEASURED（本阶段实测）

- 本机 4 个本地服务端口在监听：23114 / 23115 / 23116 / 23118（TCP connect 探测，无报文）
- 校准页面启动期会发 7 个站外请求，其中 1 个是 `POST /memory/settings`（写）
- 现有语料外，观测量全部来自真实生产装配：`dialogueChars` 分布、分档、3228 上限、273 字阈值
- 理解块固定 3 行、线索块"标题+N 行"；`understandingItems=3` / 1 条线索 `threadItems=2` → 硬触发
- 38/38 语料在"存在活跃理解文档"时 multipleThreads=true
- 旧 122 条语料 122/122 落在 dialogue 最低档
- gate state 的确定性反例（5 种宿主状态 → 3 种不同 reason）
- 生产代码零改动（`git diff HEAD -- assets services InternalBeyond.html` 为空）
- 安全包络 T1–T16 全绿（在每次回归里执行）

### INFERRED（由实测 + 代码推出的结论）

- `dlgCharsHigh` 在"只有历史"的条件下不可达（由共享核心的 8×400 上限 + 标签长度推出，已实测验证）
- `multipleThreads` 的实际语义 ≈ "该角色有活跃理解文档，或至少 1 条线索"
- 现代码路径下，桌面刷新页面会丢失 gate 状态（由模块作用域 + 无持久化推出）

### RECOMMENDED（建议，未实现）

见 §12 四条。

### UNKNOWN（必须诚实留白）

- **judge / rewrite / verify 的真实模型质量**：完全没有数据（无凭据）
- `dlgCharsLow=600` 是否"太保守"：新语料只有 3 条落在 ramp 上，样本量不足以判断真实分布；
  **用户真实对话的 dialogue 长度分布没有被测量**（见下）
- 这台机器上的真实对话数据分布：**未测量**。理由：能读到它的路径只有真实的本地
  Home Node / IndexedDB，而本阶段没有任何"只读且不把私人内容带进报告"的既有工具；
  按 §6 的条件（"ONLY if the current test tooling already supports read-only use without
  exposing private content in reports"）**条件不成立 → 不做**，而不是"悄悄读一下"
- 23118 上的服务在过去是否已经被这样的 POST 改写过设置（本阶段只做前瞻性拒绝，不回溯审计）

---

## 14 · 下一步（最小、安全）

**唯一的最小下一步：在一台合法持有凭据的桌面环境里跑 §13 的小规模 pilot** ——
`node tests/test_middle_brain_calibration_live.js --corpus=readiness --live --max-cases=5 --repeat=2`
（事前声明的调用数会被打印；最坏 5×2×1 = 10 次，因为不带 `--rewrite`）。

跑完先检查：凭据可用、schema 可解析、usage 可测、延迟被记录、judge 表现合理、
**没有任何状态被写**（报告里的 tripwire 与 denied 清单）。之后再决定是否
`--rewrite --verify` 以及是否放大到完整语料。

在此之前，**不要**开始任何调参或启用动作。
