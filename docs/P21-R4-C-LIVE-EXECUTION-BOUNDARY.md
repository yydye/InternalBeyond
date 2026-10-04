# P21-R4-C-LIVE · Execution Boundary 追加契约（Addendum）

> 阶段：**P21-R4-LIVE-2.1 · Vault-Authorized Runtime Interpretation Boundary**
> 　追加：**P21-R4-LIVE-2.2 · Runtime Interpretation Authority Truth + Exact Closure**
> 基线 HEAD：`c1b257057279a9abde8e9604c9f58783cbc058f8`
> 状态：
> ```
> R4C_RUNTIME_EXECUTION_BOUNDARY = COMPLETE
> R4C_PRODUCTION_EXECUTION       = DISABLED
> R4C_AUTO_INVOCATION            = NOT_IMPLEMENTED
> R4C_INTERPRETATION_LIVE        = NO
> EVIDENCE_INPUT_AUTHORITY       = CALLER_SUPPLIED_AUTHORIZED_PRECONDITION
> ```
> 定位：这是 **R4-C（MemoryInterpretation SHADOW）** 的追加契约，**不是** R4-F，
> 也**不**取代 R4-C 主契约。凡是本文没有写的东西，一律回到 R4-C 原文。
> ★ 2.2 只**冻结真相**（gate 可达性 / 证据输入权威），**不**修证据权威、
> **不**开 production gate、**不**接 auto caller。

---

## 0. 一句话

R4-C 交付的是"**model-ready 但生产不接**"的影子；本阶段交付的是它**第一次拥有的服务端执行边界** ——
一个**只存在于运行时**、**由 Home Node 自己解析凭据与模型**、**只有一个 operation**、
**默认关闭**、**不重试**、**不落任何持久状态**的执行路径。

它**不等于**"解释开始自动运行"。

```
R4C_LIVE_EXECUTION_BOUNDARY = COMPLETE
R4C_AUTO_INVOCATION         = NOT_IMPLEMENTED
PRODUCTION_REAL_MODEL_CALLS = 0
```

---

## 1. 冻结项（本阶段不得被后续阶段"顺手放宽"）

| # | 冻结事实 | 机器可核对的位置 |
|---|---|---|
| F1 | 传输范围 = **仅桌面**（`/internal/` 前缀属于 `isDesktopOnlyPath`） | `services/home-node/http.js` 的 `isDesktopOnlyPath`；`runtime-interpretation.js` 的 `TRANSPORT_SCOPE = 'DESKTOP_ONLY'` |
| F2 | Android 兼容 = **NOT_PROVEN**（handler/service core 未来可复用，传输与鉴权必须另行设计） | `ANDROID_COMPATIBILITY = 'NOT_PROVEN'`、`describe().androidRuntimeBoundary = 'NOT_IMPLEMENTED'` |
| F3 | 凭据/模型权威 = **Home Node 的 character runtime spec**（`registry.getCharacterSpec(characterId)`），浏览器无权选择 `credentialRef / provider / model / endpoint / apiKey` | `runtime-interpretation.js#resolveCharacterSpec`（全文件**唯一**角色配置查询点） |
| F4 | Vault 解析 = **request-scoped**，复用 `services/home-node/credential-access.js`（不复制 resolver） | 该文件里的 `.resolve` 是唯一入口；`credentialAuthority = 'HOME_NODE_CHARACTER_RUNTIME_SPEC'` |
| F5 | operation 白名单 = **只有** `memory-interpretation`；未知 operation 一律 `operation-forbidden`（fail closed），**没有**通用模型入口 | `ALLOWED_RUNTIME_DERIVATIONS` |
| F6 | 无任意 prompt 隧道：请求是**闭集**四字段；`systemPrompt / prompt / messages / developerPrompt / developer / instructions / provider / model / endpoint / credentialRef / apiKey / secret / baseURL` 出现即 **reject**（绝不 ignore） | `REQUEST_FIELDS` / `AUTHORITY_BEARING_FIELDS` / `ENVELOPE_FIELDS` |
| F7 | SYSTEM 指令与 validator 只有**一份**，来自 R4-C 纯核心 | `promptAuthority = '...memory-interpretation-core.js#SYSTEM_INSTRUCTIONS'`、`validatorAuthority = '...#validateResponse'` |
| F8 | server-side cost gate，**默认 OFF**；`CALLER_INTENT != SERVER_COST_POLICY` | `resolveCostPolicy`；`costPolicy.defaultEnabled = false`；`productionEnablePath = 'NONE_IN_THIS_PHASE'` |
| F9 | 超时由**调用方显式**给出，服务端用**同一个**值；缺失即 `timeout-authority-missing`，绝不发明默认值 | `timeoutAuthority = 'CALLER_EXPLICIT'`；上界 `SAFETY_CAP_MS = 120000`（来源见 `SAFETY_CAP_SOURCE`） |
| F10 | **不重试**：`AUTO_RETRY = 'NONE'`、`MAX_ATTEMPTS = 1`；模糊传输失败绝不重发收费请求 | `MAX_ATTEMPTS` / `AUTO_RETRY` |
| F11 | 结果恒为 **non-durable**：`durable:false`、`metaMemoryState:null`、`recollectionQuality:null` | R4-C `assembleShadow` 原始语义 |
| F12 | 秘密只活在"请求作用域 → provider 调用"之间；不进 response / error detail / trace / log / describe / 契约快照 | `redactSecret`、provider-error detail 不含 provider 原文 |
| F13 | auto invocation = **NOT_IMPLEMENTED**；`assets/js/communication.js` 一字未改 | `AUTO_INVOCATION` |
| F14 | 未来执行缝登记为 **POST_RECALL_NONBLOCKING**，但那是**未来**阶段的事 | `EXECUTION_SEAM` |
| F15 | R4-F 仍然被挡：`R4_F_LIVE_MEDIATOR_REQUIREMENT = L3_AND_L5`、`R4-F_AUTHORIZED = NO` | 见 §7 |

---

## 2. 传输契约

```
POST /internal/runtime/memory-interpretation
```

* 路径常量只有一份：`runtime-interpretation.js#MEMORY_INTERPRETATION_PATH`，
  `http.js` 从服务对象的 `.path` 取值，**不重写字面量**。
* 动词只有 `POST`；`GET / PUT / DELETE / PATCH / HEAD` → `405 runtime-interpretation-is-post-only`。
  **`OPTIONS` 例外**：它在路由派发**之前**就被既有的全局 CORS 预检分支回答（`http.js` 的
  既有行为，作用于本服务的**每一条**路径），返回 204 且**零执行、零 provider 调用**。
  这不是本阶段新增的豁免，也不改变"只有一个动词"这句话的语义 —— 它只是如实说明
  "一个预检请求从来就不是一个动词"。
* 桌面凭据：`/internal/` 前缀已被 `isDesktopOnlyPath` 归入桌面面，
  并且本路径**不**享受 Economy command channel 那种"自带凭据域"的豁免 ——
  它照常走 `authorized()`（未配置 token 时 loopback 放行、
  远端未配置 token 时先 `403 remote-admin-disabled`）。
* 请求体上限沿用 `MAX_BODY_BYTES`；读体失败与其它 POST 写路径同形。

### 请求（闭集，恰好四个字段）

```json
{
  "operation": "memory-interpretation",
  "characterId": "<角色 id>",
  "timeoutMs": 20000,
  "inputEnvelope": { "selectedIds": [], "records": [], "evidence": {}, "currentState": {}, "roleName": "" }
}
```

* `inputEnvelope` 同样是闭集：`selectedIds / records / evidence / currentState / roleName`。
* `timeoutMs` 必须是真正的 `number`（`>0`、有限）；数字字符串不是权威。
* 上限 120000ms，超出由服务端 clamp，并在成功结果上以 `timeoutClamped:true` 如实回报。

### 响应

成功 = R4-C `assembleShadow` 的**原始形状** + `operation / characterId / timeoutMs / timeoutClamped / status / boundary`。

失败 = 与 R4-C runner 的 `unavailable()` 同形的信封 + `error / reasonCode / status / boundary`：

```
{ ok:false, durable:false, operation, characterId, error, reasonCode, reasonCodes[],
  items:[], missingFor:[], rejected:[], counts:{requested,returned:0},
  model:{providerClass, modelId, latencyMs, status, attempts},
  metaMemoryState:null, recollectionQuality:null, boundary:{...}, status }
```

**浏览器永远收不到**：provider 原文、raw JSON 文本、provider reasoning、prompt 文本、秘密及其元数据。

---

## 3. 失败词表（对外的码）

| 码 | 含义 | HTTP |
|---|---|---|
| `disabled` | server cost policy 未开（默认形态） | 503 |
| `operation-forbidden` | operation 不在白名单（含缺失/非字符串） | 403 |
| `request-shape-invalid` | 信封/字段形状不合法 | 400 |
| `request-field-forbidden` | 出现闭集之外的字段（**reject**，不 ignore） | 400 |
| `runtime-spec-unavailable` | 角色不存在、spec 缺失或不完整（缺 `credentialRef` 也算） | 404 |
| `credential-unavailable` | Vault fail closed（未授权 binding / 取不到秘密） | 503 |
| `timeout-authority-missing` | 调用方没给 `timeoutMs` | 400 |
| `timeout` | 上游超时（R4-C 码：`model-timeout`） | 504 |
| `provider-error` | provider 抛错（R4-C 码：`model-transport-error`） | 502 |
| `network` | 可观测的网络失败形状（如 `TypeError` + `cause.code`) | 502 |
| `invalid-output` | 上游输出不是 JSON / 不是对象 / 为空（R4-C 码：`model-json-invalid`） | 502 |
| `aborted` | 调用方取消（R4-C 码：`model-aborted`） | 499 |
| `model-port-unavailable` | 宿主没有可用的模型端口 | 503 |
| `no-authorized-memory` | 没有任何已授权记忆可解释（R4-C 既有码，零成本） | 422 |
| `model-*`（R4-C） | 结构化输出攻击被**同一份** validator 拒绝（shape/enum/bound/unknown-id/duplicate/…） | 502 |

`reasonCodes` 会**同时**给出边界码与它映射到的 R4-C 码，并带上逐条拒绝理由
（`validated.rejected[].reason`）—— 使"核心词表"与"边界词表"的对应关系可断言。

---

## 4. 非持久性

一次调用**只**做四件事：读角色目录、经 Vault 读一次秘密、调用一次 provider、校验后返回。
它**不**写 Understanding store、**不**写 memory store、**不**写 relationship、**不**写 change log、
**不**写 SQLite / IndexedDB，**不**推进任何 revision 或 watermark。

> 凭据的**正常读取**不是 mutation（§33 已登记）。

### 4.1 本阶段的信任边界（P21-R4-LIVE-2.2 机械冻结）

`inputEnvelope.records` 是**调用方自己提交**的输入集 —— 调用方**自称**它是"已授权的"，
而本边界**不复核**这个自称：它**不**读 canonical `memory_records`、**不**重跑 recall、
**不**校验 record id 是否存在、**不**校验内容是否等于 canonical 文本、
**不**校验角色可见性、也**不**校验这个 selected set 是否来自一次真实召回。
（R4-C 的 `normalizeInput` 只做**有界**归一化，以及"未出现在 records 里的 id 直接跳过"。）

因此一个**持有桌面凭据**的调用方可以把任意文本作为 **DATA** 放进模型请求的 USER 段。
这条结论是**实测**的，不是推断的：见 §10.5 的四条攻击与它们的实测取值。

**够不到的东西**（结构上不可达，已由测试与独立复核逐项证明）：
system prompt（服务端常量）、provider、model、endpoint、credentialRef、apiKey、
operation（闭集）—— 以及任何持久状态。

**这是刻意的**：本阶段的权威分工是"浏览器负责召回选择、Home Node 负责凭据与执行"。
等到 auto-caller 阶段把召回搬进服务端（POST_RECALL_NONBLOCKING），
`records` 的来源必须一并改成服务端读 canonical memory，否则这条信任边界会
原样继承下去。**本阶段不假装它已经解决，也不在本阶段修它。**

---

## 4.2 Authority 冻结表（P21-R4-LIVE-2.2）

```
MODEL_EXECUTION_AUTHORITY   = SERVER                （provider/model/endpoint 由角色 runtime spec 解析）
CREDENTIAL_AUTHORITY        = HOME_NODE_VAULT       （services/home-node/credential-access.js，request-scoped）
SYSTEM_PROMPT_AUTHORITY     = SERVER                （R4-C 常量；任何 systemPrompt/prompt/messages 输入一律 reject）
OPERATION_AUTHORITY         = SERVER_ALLOWLIST      （只有 memory-interpretation）
EVIDENCE_INPUT_AUTHORITY    = CALLER_SUPPLIED_AUTHORIZED_PRECONDITION
                                                      （调用方自称已授权；server 不复核 —— 见 §4.1）
```

```
R4C_RUNTIME_EXECUTION_BOUNDARY = COMPLETE
R4C_PRODUCTION_EXECUTION       = DISABLED
R4C_AUTO_INVOCATION            = NOT_IMPLEMENTED
R4C_INTERPRETATION_LIVE        = NO
```

**执行权威已闭合，证据权威未闭合**（execution authority closed / evidence authority not closed）。
"路由在测试里能跑"**不等于**"Interpretation production live"。

### 4.3 Production enable 的前置条件（冻结，本阶段不实现）

```
PRODUCTION_ENABLE_PREREQUISITE = SERVER-BOUND AUTHORIZED RECALL/EVIDENCE
```

在真正打开 server cost gate 或接 auto caller **之前**，必须至少满足其一：

* **A.** server 自己执行 **authorized recall**（读 canonical memory + 同一份可见性核），或
* **B.** server 接收一个**由 server 自己发出、调用方不可伪造**的 recall/evidence capability，

或另一种经过审计的 authority。**本阶段只做分类，不动实现**：
不搬 recall 进 Home Node、不新增 canonical query route、不新增 capability protocol。

---

## 5. 取消与断连（如实主张，不多说一个字）

三个概念**分别**登记，绝不合并成一句"bounded"：

| 事实 | 取值 | 证据 |
|---|---|---|
| `SIGNAL_FORWARDING_PROVEN` | YES | 外层 `AbortSignal` → service → `modelPort.run(req, {signal})` → `NodeModelPort` 内部 controller → `fetch(init.signal)` |
| `FETCH_ABORT_PROVEN` | YES | fake fetch 观察到 `init.signal.aborted === true` |
| `PROVIDER_COST_STOP_PROVEN` | **NO** | fetch 层收到 abort ≠ 上游已停止计算与计费；本阶段不主张后者 |
| `RUNNER_WAIT_BOUNDED` | YES | 即使端口完全忽略 signal，边界仍在有界时间内返回 |
| `SERVER_EXECUTION_MAY_CONTINUE_AFTER_CLIENT_DISCONNECT` | YES | 传输层把 `aborted`/`close` 桥接成 abort 并转发；这**不**证明上游执行已停止，也**不**为本阶段重构 HTTP server |

---

## 6. 与 R4-C 主契约的关系（不发明第二套）

* **SYSTEM_INSTRUCTIONS**：一份（`assets/js/memory-recall/memory-interpretation-core.js`）。
* **validator**：一份（`validateResponse`）；本阶段的边界只**调用**它。
* **信封构造**：一份（`buildRequest`）。
* **结果 schema**：沿用 `assembleShadow`，只在外面加了审计字段；
  `durable:false` 等语义字段来自核心，不是这里重新定义的。
* **model port**：复用 `active/node-model-port.js`（或同形注入），单次 `run`。

---

## 7. R4-F Gate（本阶段**没有**改变它）

```
R4_F_LIVE_MEDIATOR_REQUIREMENT = L3_AND_L5
R4-F_AUTHORIZED                = NO
```

理由逐字未变：L3 的 auto live **尚未启用**（本阶段只交付边界，不接调用方），
L5 仍然只是 protocol-only。**完成这个边界不等于满足 R4-F 的前置条件。**

2.2 追加冻结：`R4C_PRODUCTION_EXECUTION = DISABLED` 与 `R4C_INTERPRETATION_LIVE = NO`
使得"L3 auto live 未启用"从一句叙述变成两条可核对的机器事实 ——
而 R4-F 的前置条件（L3 **and** L5）因此**依然不成立**。

---

## 8. 观测（复用 R4-LIVE-1 纪律）

允许记录/回报的只有：`status`、`operation`、`characterId`、`latencyMs`、
`model class/id`（provider 名与 model 名，均非秘密）、`attempts`、`providerCalls`、`vaultReads`、
`outcome`（码）。

**不**允许：完整 Interpretation 正文进 MetaMemory diagnostics；秘密进任何观测面。
完整结果只返回给**显式调用方**，并保持 turn-local / non-durable。

---

## 9. Scope

| 类别 | 内容 |
|---|---|
| **PRODUCTION** | `services/home-node/runtime-interpretation.js`（新增）、`services/home-node/http.js`（路由接线）、`services/home-node-service.js`（两条装配路径）、`assets/js/home-node-client.js`（最窄 browser client）、`assets/js/home-node-bootstrap.js`（挂载窄面） |
| **TESTS** | `tests/test_r4c_live_runtime_boundary.js`、`tests/test_r4c_live_browser_boundary.js` |
| **DOCS** | 本文件 |
| **UNKNOWN** | **0** |

**明确未修改**：`assets/js/communication.js`、`assets/js/memory.js`（用户 hunk）、
`InternalBeyond.html`、Middle Brain、任何 UI、任何 schema/migration。

---

## 10. 验证证据

### 10.1 本阶段新增的两条套件（clean candidate）

| 命令 | 结果 |
|---|---|
| `node tests/test_r4c_live_runtime_boundary.js` | **exit 0 · 217 PASS / 0 FAIL** |
| `node tests/test_r4c_live_browser_boundary.js` | **exit 0 · 39 PASS / 0 FAIL** |

机器可读结论（由测试直接打印，取值来自实测）：

```
VALIDATOR_IMPLEMENTATION_COUNT   = 1        （validateResponse 全仓仍只有一份）
SYSTEM_INSTRUCTIONS_DEFINITION_COUNT = 1
SIGNAL_FORWARDING_PROVEN         = YES
FETCH_ABORT_PROVEN               = YES
PROVIDER_COST_STOP_PROVEN        = NO       （不主张上游已停止计费）
RUNNER_WAIT_BOUNDED              = YES
RUNTIME_BOUNDARY_TRANSPORT_SCOPE = DESKTOP_ONLY
ANDROID_COMPATIBILITY            = NOT_PROVEN
PATH_LITERAL_SOURCES_CONSISTENT  = YES
AUTO_INVOCATION_ABSENT           = YES
SERVER_ENABLE_PATH_ABSENT        = YES
REAL_PROVIDER_CALLS              = 0
```

哨兵 `SECRET_SENTINEL_INTERP_91B7`：在整条 provider 请求里**恰好出现一次**
（`Authorization: Bearer …`），在响应字节、日志、`describe()`、`/security`、
以及 provider-error / timeout / credential-unavailable 三类失败信封里**零命中**。

非持久：真实 temp-dir 实例上，成功调用与失败调用前后，
`memory_records` 计数与 revision、memory change feed、Understanding revision 与
watermark、chat meta、SQLite 文件与 Vault 文件的 sha256 全部逐字节不变
（而 Vault **确实**被读过 —— 哨兵到达了 provider）。

### 10.2 客户端断开（Lead 直接对真实 `createHomeNodeHttp` 探针）

```
SIGNAL_FORWARDED_ON_CLIENT_DISCONNECT  = YES   （req 'aborted' / res 'close' → AbortSignal）
SERVER_EXECUTION_MAY_CONTINUE_AFTER_CLIENT_DISCONNECT = YES（服务忽略 signal 时确实继续）
SERVER_SURVIVED_DISCONNECT             = YES
```

### 10.3 回归（相对 pristine `git archive HEAD` 基线）

35 条套件里 6 条红，**全部为 baseline parity（新失败 = 0）**：

| 套件 | 现状 | 基线 | 归因 |
|---|---|---|---|
| `test_memory_recall_contract.js` | 185 passed / 2 failed | HEAD 干净树 0 失败 | 两条 `P18.unchanged` 分别是用户未提交的 `memory.js` / `communication.js`；本阶段的 `home-node-bootstrap.js` 改动的 pin 已按该文件既有约定显式更新，**本阶段 delta = 0** |
| `test_memory_recall_wiring_guard.js` | 52 passed / 2 failed | 同上 | 下游（`B1.contractStillGreen` / `B2`）+ 同样两条 P18 |
| `test_home_node_service.js` | 25 passed / 3 failed | **identical** | 三条静态正则对 HEAD 的 `home-node-bootstrap.js` 已经为假 |
| `test_home_node_lan_gate.js` | 39 passed / 13 failed | **identical** | 本机存在持久化桌面凭据（P22-23 自动 provisioning），测试期望停留在 P22-23 之前 |
| `test_home_node_client_envelope.js` | 54 passed / 1 failed | **identical** | `A1` 期望里没有 `/internal/desktop-credential` provisioning 请求 |
| `test_credential_authority_r5_adapter.js` | 崩溃 | **identical** | 依赖本机 `%LOCALAPPDATA%\InternalBeyond\apiConfigs_recovery_import.json`（不存在） |

绿的部分包含：R4-C 影子（77）、MetaMemory 影子（65）、MetaMemory observability smoke（28）、
Counterfactual（81）、Expectation（95）、Reconstructive memory contract（87）、
R2-F baseline/delta/cooldown（22/39/18/11）、recall orchestrator（77）、seats（72）、
two-host parity（152）、wiring guard 的 B 组之外部分、memory contract closure（153）、
Home Node execution（60）、middle-brain assembly（25）、understanding derivation（59）、
credential migration（12）、production memory assembly（30）、credential authority r4/r7、
credential write path 等 —— **全部 exit 0**。

> 说明：`test_middle_brain_convergence_counterproof.js` 在 HEAD 上就已经是 12 passed / 1 failed；
> 本阶段新增的 `home-node-service.js → runtime-interpretation.js` require 边使那条**已经失败**的
> `addedByClosure` 列表多出一项，失败计数不变。该套件不在本阶段回归名单内，且未被修改。

### 10.4 独立对抗复核（另一名执行者，不共享实现者上下文）

**28 / 28 项 CONFIRMED · 0 REFUTED · 0 UNKNOWN**（原始报告：
`.dsh-research/r4c-live-2-1-verification.json`）。复核者自行构造的探针全部 exit 0：
服务层 259/259、真实装配 HTTP 107/107、浏览器客户端 VM 沙箱 16/16、validated-result-only 12/12；
22 类攻击（18 个字段的走私矩阵 × 顶层 / 信封内 / `__proto__` 与 `constructor.prototype` 污染、
10 种 cost policy 形态、明文 `spec.apiKey` 回落、18 条 no-retry 路径、带种子的 sqlite 逐表哈希、
12 类裸字节哨兵扫描）无一突破。

回归由复核者用**独立方法**再推一遍：以"pristine HEAD + 仅本阶段文件"的 overlay 树复算 ——
`test_memory_recall_contract.js` 与 `test_memory_recall_wiring_guard.js` 在该 overlay 树里
**双双 exit 0**（187 / 54 green），即**本阶段可归因的失败 = 0**。

复核发现的两处轻微不精确**已修**：

1. **审计自述**：`credential-unavailable` 路径上信封曾报 `boundary.vaultReads=0`，
   而该请求确实读过一次 Vault。现在所有路径统一取**本次请求的实测计数**
   （`vaultReadsForRequest`），信封、`describe().counters` 与实际 `resolve()` 调用三者一致。
2. **文档**：`OPTIONS` 由既有全局 CORS 预检分支回答 204（见 §2），原 §2 的措辞已修正。

复核登记的**信任边界**（不修，如实记入 §4.1）：`inputEnvelope.records` 是调用方提交的
已授权集，本边界不向 memory store 复核；system prompt / provider / model / endpoint /
凭据仍然结构上不可达。

### 10.5 Authority Truth（P21-R4-LIVE-2.2 · 机械实测）

命令：`node tests/test_r4c_live_authority_truth.js` → **exit 0 · 99 passed / 0 failed**。

```
SERVER_GATE_EXISTS                         = YES
SERVER_GATE_DEFAULT                        = FALSE
PRODUCTION_ENABLE_PATH_EXISTS              = NO
TEST_ONLY_ENABLE_PATH_EXISTS               = YES
PRODUCTION_GATE_HARD_OFF_PROVEN            = YES
CALLER_CAN_SUPPLY_ARBITRARY_RECORD_TEXT    = YES
SERVER_BINDS_RECORD_CONTENT_TO_CANONICAL   = NO
SERVER_ENFORCES_EVIDENCE_CHARACTER_VISIBILITY = NO
R4C_EVIDENCE_INPUT_AUTHORITY               = C CALLER_SUPPLIED_AUTHORIZED_PRECONDITION
SYSTEM_PROMPT_AUTHORITY                    = SERVER
DATA_CONTENT_AUTHORITY                     = CALLER
ARBITRARY_SYSTEM_PROMPT_TUNNEL             = NO
CALLER_CONTROLLED_UNTRUSTED_DATA_CHANNEL   = YES
```

**gate hard-off 的证据形态**：真实 `node services/home-node-service.js` 子进程（私有
temp 数据目录 + 显式测试 token + 自由端口），**合法**请求 → HTTP 503 `disabled`
（`source=absent-default-false`），`boundary.providerCalls=0`、`vaultReads=0`、`attempts=0`；
`/security.runtimeInterpretation.costPolicyEnabled=false`；子进程日志出现
`runtime-interpretation-disabled` 而**从未**出现 `runtime-interpretation-ok`。

**无意外 enable 的证据形态**：`runtime-interpretation.js` 里 `process.env` 读取 **0 次**；
http.js 唯一一处 env 读取是既有的 `IB_HOME_NODE_TRACE`（trace 日志，无 INTERPRETATION 键）；
全仓 `assets/services/bridge/src-tauri/runtime` 的 `.js/.rs/.toml/.html` 里
`/INTERPRETATION/` 匹配的 env 键 **0 个**、`IB_ENABLE_INTERPRETATION` 字面量 **0 个**；
15 种 policy 形态实测：`undefined/null/false/{}/'true'/1/'yes'` 全部 → `disabled` 且零成本。
攻击体 `{enabled:true}` / `?enabled=1&memoryInterpretationEnabled=true` → 400 `request-field-forbidden`，零成本。

**证据权威的四条攻击（全部实测）**：

| 攻击 | 实测 |
|---|---|
| 伪造 record id + 任意文本 | `ARBITRARY_CALLER_TEXT_91C2` **原样**到达 provider 的 `MEMORY_BATCH[0]` |
| 已存在的 canonical id + 伪造 content | provider 收到 `FORGED_CONTENT_91C2`；canonical 文本**从未出现**；canonical 行调用后不变 |
| 跨角色证据（B 的行 / B 形状） | 真实 ACL 已把 B 的行对 A 隐藏，但 A 的请求仍把该文本送到 provider ⇒ **不拒绝** |
| 有界性 | 闭集信封；`>64` records/ids → 400；12 个 selectedIds → wire 上恰好 8；5000 字 content → wire 上恰好 1200 |

⇒ 既不是 A（server canonical authority）也不是 B（server 校验 caller records），
而是 **C**；也**不是** D，因为闭集与三重上限使输入**有界**。

**上一轮对抗结论的修正（§18）**：2.1 的 28/28 CONFIRMED 全部仍然成立，
但其中"`ARBITRARY_SYSTEM_PROMPT_TUNNEL = NO`"**只覆盖 system 权威**，
不得被读成"不存在任意模型代理"—— 数据通道是**调用方控制**的（见上表）。
`SYSTEM_PROMPT_AUTHORITY` 与 `DATA_CONTENT_AUTHORITY` 是两件事，本契约自此分开登记。

**已登记的未修观察（future）**：`describe().costPolicy.source` 报告的是**解析后取值**的形状
（函数返回对象时显示 `assembly-policy-object`），不是注入形态；`enabled` 取值始终正确，
不影响闸门，留待后续阶段。

