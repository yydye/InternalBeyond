# Middle Brain 架构

**Status: Canonical**
**Scope: 当前 Middle Brain runtime 架构**

> 本文档描述 Middle Brain runtime 在**当前**是如何工作的。它不是 phase report、closure 或 audit。
> 凡涉及历史之处，仅为 provenance。
> Source-of-truth 优先级：当前生产代码 → 当前 enforcing tests → 当前 canonical docs /
> `DECISIONS.md` → 历史记录。

---

## 1. 目的

Middle Brain（MB）是 InternalBeyond 在 **character model 生成边界周围的认知中间层**。它不回答用户；
它在生成前准备上下文，并在生成后评估角色一致性。

它负责：

- **pre-generation**：上下文组织、上下文压缩，以及 admission / local-fallback 决策；
- **post-generation**：character-integrity 评估、一次可选的针对性 rewrite，以及
  side-effect policy 的推导；外加一个只读的 quality Judge。

它**不是**：character reply 生成器、character provider 选择器、memory store 或 writer、
tool executor、Image Router executor、provider prompt cache，或通用 prompt owner。

---

## 2. Runtime 位置

Canonical 实现（browser）：

| 模块 | 职责 |
| --- | --- |
| `assets/js/middle-brain.js` | facade：`IB.middleBrain`、pre/post seams、dev trace |
| `assets/js/middle-brain-config.js` | config 读/写、UI 绑定、settings card |
| `assets/js/middle-brain-config-core.js` | config 归一化、runtime predicates、projection、MB system prompt |
| `assets/js/middle-brain-policy.js` | 上下文组织、压缩、Admission Gate |
| `assets/js/middle-brain-astra.js` | MB 自身的 network/model 边界 |
| `assets/js/middle-brain-judge.js` | 只读 quality observation + telemetry |
| `assets/js/middle-brain-integrity.js` | Character Integrity guard + side-effect policy |

Host adapter：

| 模块 | 职责 |
| --- | --- |
| `services/home-node/middle-brain.js` | Home Node host adapter；通过 UMD/global shims（`loadCanonicalMiddleBrain`）加载**同一份** canonical 实现 |

Home Node 模块**不是第二个 Middle Brain**。它是一个 adapter，安装一个 configuration reader
（`globalThis.__ibMiddleBrainConfigReader`），并以与 browser 相同的形态暴露两个 seams
（`organizeContext` / `finalizeReply`）。它自身不做任何判断。

---

## 3. Canonical Facade

`IB.middleBrain` 是唯一的生产入口。它由 `assets/js/middle-brain.js:336` 处冻结的逐层 contracts
（`MBC.config / policy / astra / judge / integrity`）组装而成，并在 `assets/js/middle-brain.js:351`
处发布。架构相关的 seams 列于 §5；facade 的完整 key 列表属于实现细节，此处有意不复制。

---

## 4. Canonical 执行流程

```text
Caller (single chat / group chat / Role DM / Home Node execution)
  │  context snapshot / dialogue / selected context
  ▼
IB.middleBrain  ·  middleBrainExecute / middleBrainCompressPipeline
  ├─ organize   (memory / understanding / thread / moments / dialogue)
  ├─ compress   (dedupe + priority + budget)
  └─ admission  ── Astra ──► (Astra cognitive compression)
                └─ local  ──► (local compressed context)
                └─ bypass ──► (return null; caller keeps its own context)
  ▼
compressedContext
  ▼
Caller performs final injection        ← injection authority is the caller
  ▼
IBModelCore / character provider        ← character model execution
  ▼
candidate reply
  ▼
IB.middleBrain  ·  middleBrainFinalizeReply
  ├─ integrity judge
  ├─ sensitivity gate
  ├─ optional targeted rewrite (at most one)
  └─ optional verify (observation only)
  ▼
reply + outcome {verdict, rewritten, reason}
  ▼
side-effect policy gates (consumer-applied)
```

MB 的 **composition**、**caller injection** 与 **model execution** 是三个不同的阶段：

> Middle Brain 返回压缩后的上下文。它是否——以及如何——被注入 character model 请求，由 caller 决定。
> caller 也拥有最终的 character 请求。

---

## 5. Canonical Seams

| Seam | Canonical Entry | 职责 | 不拥有 |
| --- | --- | --- | --- |
| Pre-generation | `middleBrainExecute` (`middle-brain.js:201`) | readiness check + pipeline | context injection |
| Pre-generation (pipeline) | `middleBrainCompressPipeline` (`middle-brain.js:147`) | organize → compress → admission/Astra | context injection、character request |
| Post-generation | `middleBrainFinalizeReply` (`middle-brain.js:231`) | integrity guard；返回 `{reply, outcome}` | reply generation、retry |
| Side-effect policy | `middleBrainSideEffectAllowed` | 依据 verdict 的 allow/suppress 决策 | 执行 side effect |
| Group memory policy | `middleBrainGroupMemoryPolicy` | group memory scope 决策 | memory persistence |
| Suppression snapshot | `middleBrainSideEffectSuppression` | 读取该 turn 的 suppression record | enforcement |
| Config decision | `middleBrainReasoningEffort` | canonical reasoning value | provider translation |
| Config decision | `middleBrainImageMode` | canonical image policy 决策 | image execution |

---

## 6. Layer 架构

```text
config  →  policy  →  astra  →  judge / integrity  →  facade
```

- **config**（`middle-brain-config.js`、`-config-core.js`）：configuration 归一化、runtime
  predicates、canonical config projection、MB system prompt 常量。
- **policy**（`middle-brain-policy.js`）：将上下文组织为四个类别
  （memory / understanding / thread / moments）外加 dialogue，进行本地压缩，并包含 Admission
  Gate（本地、确定性、无 LLM；决定是否花费一次 Astra 调用）。
- **astra**（`middle-brain-astra.js`）：MB 自身的 network/model 边界——request/response
  归一化，以及用于 compression、judging 与 rewriting 的 Astra calls。
- **judge**（`middle-brain-judge.js`）：对压缩结果的只读 quality observation +
  telemetry。默认关闭；永不改变执行结果。
- **integrity**（`middle-brain-integrity.js`）：角色一致性、verdict、targeted rewrite 与
  side-effect policies。
- **facade**（`middle-brain.js`）：组装并发布 `IB.middleBrain`。

每一层只依赖上游层（DAG）；逐层导出为冻结的 contracts。

---

## 7. Historical Terminology 警告

历史 P11 材料对 "five layers" 的使用与当前架构不同。

- **当前物理架构**（五个功能层 + facade）：
  `config / policy / astra / judge / integrity` + `facade`。
- **当前 integrity dimensions**（六个）：`persona / speech_style / relationship /
  emotional_continuity / knowledge_boundary / behavior`。

不要将两者混为一谈，也不要把 `persona / relationship / emotion / knowledge / speech` 称为
"Middle Brain five-layer architecture"。那是一种历史术语漂移，而非当前结构。

---

## 8. Context 职责

| Context | Authority | MB Role |
| --- | --- | --- |
| memory | other runtime | 读取 / 压缩 |
| understanding | other runtime | 读取 / 压缩 |
| thread | other runtime | 读取 / 压缩 |
| moments | other runtime | 读取 / 压缩 |
| dialogue / history | caller | 读取 / 压缩 |
| persona (nickname / bio / relationship / role prompt) | caller | 仅 integrity **evidence** |
| role system instruction | caller | 不拥有 |
| MB system instruction | MB | 仅自己的 Astra calls |
| attachments / images | caller | 不拥有 |
| tools | caller / runtime | 不拥有 |

核心不变量：**可见性不等于 authority。** Middle Brain 可以读取一个 context 而不拥有它。
Ownership 归属于产生它的 runtime 或 caller。

---

## 9. Character Integrity

Character Integrity 是 post-generation guard。它是 policy + validator + targeted rewriter，而不是
filter 或 composer。

**Dimensions（六个，`middle-brain-integrity.js:28`）：** `persona`、`speech_style`、`relationship`、
`emotional_continuity`、`knowledge_boundary`、`behavior`。

**Verdicts（`middle-brain-integrity.js:82`）：** `PASS`、`OOC`、`UNDECIDED`、`BYPASSED`。

**流程：** candidate → judge → sensitivity gate → optional targeted rewrite → optional verify →
final reply + outcome。

当前不变量（production-backed）：

- rewrite 对每个 candidate **至多尝试一次**；
- verify 是**纯观察**，永不执行第二次 rewrite；
- timeout / error / malformed judge output **绝不**被强制转为 `PASS` 或 `OOC`；它产出
  `UNDECIDED`；
- failures 永不使该 turn 失败——candidate 直接透传；
- Character Integrity **默认禁用**（`characterIntegrityEnabled:false`）；
- voice surface 当前**被显式 bypass**（`voice_surface` skip）。

`UNDECIDED` 不是 `OOC`；`BYPASSED` 不是 `PASS`。

---

## 10. Side-Effect 边界

integrity outcome 不只是一个文本结果。verdict 会输入当前下游的 policy seams：

- `middleBrainSideEffectAllowed` — 逐 site 的 allow/suppress 决策（`MB_CI_SIDE_EFFECT_SITES`；
  四个 adjudication points：mem_ops、calendar、blog_read、ws_ops）；
- `middleBrainSideEffectSuppression` — 跨类别的逐 turn suppression record
  （memory、calendar、blog_read、workspace、file_archive、tool_continue）；
- `middleBrainGroupMemoryPolicy` — group memory scope 决策（writable scope 为 `private_role`）。

Middle Brain **提供一个 policy 决策**；下游 consumer 执行实际的 execution 或 suppression。
MB 并不控制所有 side effects。

---

## 11. Configuration Authority

Canonical storage：IndexedDB `apiSettings['middle_brain']`。架构相关的字段：

| Field | 含义 | Default |
| --- | --- | --- |
| `enabled` | MB runtime 开关（见 §12） | `false` |
| `endpoint` / `model` / `apiKey` | MB 自身的 model channel | OpenAI Responses URL / `gpt-6-astra` / `''` |
| `reasoningEffort` | canonical thinking depth（见 §15） | `auto` |
| `speed` | MB service/latency 层级 | `standard` |
| `imageMode` | Image Router policy 决策 | `auto` |
| `admissionEnabled` | Admission Gate 开/关 | `true` |
| `middleBrainJudgeEnabled` | quality Judge 开/关 | `false` |
| `characterIntegrity*` | integrity enable / sensitivity / rewrite / verify | `false` / `conservative` / `false` / `false` |

`apiKey` 是凭据边界，永不 projection 到另一个 host（§14）。

---

## 12. Enabled 状态

`middleBrainRuntimeEnabled(config)`（`middle-brain-config-core.js:147`）是**唯一的 canonical
runtime predicate**：

```text
enabled && non-empty(endpoint) && non-empty(model)
```

`isMiddleBrainEnabled` 与 settings-card status badge 读取同一个 predicate。注意它**不**包含
`apiKey`；Astra readiness 是单独的 predicate `middleBrainApiReady`
（`enabled && endpoint && model && apiKey`）。

历史缺陷 "UI Enabled while runtime Disabled" 是过去的问题（见 §25），不是当前行为。

---

## 13. Save / Immediate 语义

settings card 是一个 configuration surface。两种 save 语义并存：

- **Save-to-apply**：`enabled`、`endpoint`、`apiKey`。保存是更新 runtime mirror 的唯一时点。
- **Immediate persistence**：`model`、`reasoningEffort`、`speed`、`imageMode` 以及 integrity
  字段在选取时即持久化。

一个 pristine/runtime snapshot 支撑 saved/unsaved 显示。本节记录的是 configuration
surface，而非 MB runtime 架构。

---

## 14. Cross-Host Projection

Execution configuration 通过一个显式 allow-list 从 Browser → Home Node 进行 projection：

- `MB_EXECUTION_KEYS`（`middle-brain-config-core.js:217`）— 九个 keys；
- `projectExecutionConfig`（`middle-brain-config-core.js:228`）— 构造式、逐字段、无任意
  fallback。

> **`apiKey` 不被 projection。** 因此 Home Node 永远收不到 desktop MB 凭据。
> 于是 Home Node 上 `middleBrainApiReady` 为 false，Admission Gate 解析为
> `astra_not_ready`，Home Node 通过同一 canonical core 运行 **local pipeline**。

这是有意的 host 边界，而非缺失的功能。

---

## 15. Reasoning 边界

```text
UI
 → reasoningEffort (canonical config)
 → MB canonical config
 → Astra request builder
 → IBModelCore adapter
 → provider-specific translation
```

Canonical enum：`auto / low / medium / high / max`（`middle-brain-config-core.js:161`）。

- **MB owns** canonical reasoning value。
- **MB does not own** provider 专属的 reasoning translation。`middle-brain-astra.js:73-91` 只产出
  canonical value；provider capability translation 发生在 provider request builder
  （`IBModelCore` / `provider-directory.js`）。
- `reasoning_effort`（provider snake_case）**不是** MB canonical storage；MB 仅为 fast tier 发出官方
  `service_tier`。

---

## 16. Provider 边界

两个不同的 provider 概念：

- **MB own model channel** — MB 持有自己的 `endpoint` / `model` / `apiKey`，用于 compression、
  judging 与 integrity rewrite。其 transport 通过 `IBModelCore` 的 Astra adapter 归一化。
- **Character provider** — character reply 的 provider/model **不受 MB 控制**；它属于
  caller、`IBModelCore` 以及 provider directory。

> Middle Brain 拥有自己的 model channel 并不意味着 Middle Brain 是 character model routing
> 的 owner。

---

## 17. Memory 边界

Middle Brain **读取选定的 context**、**压缩**它，并**返回**压缩后的 context。它
**不** hydrate memory、不拥有 canonical memory storage、不执行 consolidation、不写 memory，也不拥有
retrieval lifecycle。

当 memory context 不可用时，它被记录为 missing，MB 继续（empty / local / bypass）。
这种韧性行为不会使 MB 成为 memory component。

---

## 18. Image Router 边界

`middleBrainImageMode` 仅返回 canonical image policy 决策（`fast / auto / precision`）。
Middle Brain 不选择 image provider、不执行 generation、不管理 Image Router 凭据，
也不发起 image requests。Image Router 是 executor。

---

## 19. UI 边界

Middle Brain settings card 是一个 **configuration surface**，而不是 Middle Brain runtime。该 card
负责 configuration、saved/unsaved 显示、collapse 状态与 status 显示。Runtime
authority 位于 canonical MB modules 中。

面向用户的 surfaces 不在 Middle Brain runtime 架构的 ownership 之内。

---

## 20. Diagnostics / Observability

- **Home Node diagnostics**（`services/home-node/middle-brain.js`）：availability、load status、已安装的
  shims、layer contract keys、facade key count、snapshot-contract 是否存在、config-reader 状态。它
  不包含任何 configuration 内容，也不包含凭据。
- **Judge telemetry**：只读的 quality 计数与 latency。
- **Integrity telemetry**：verdict 计数、judge/rewrite/verify 计数器、suppression 计数器。
- **Dev trace**：`IB.__mbTrace` 是一个 **dev-only** 的内存 ring。它记录 state、flags、counters，以及
  选定的 metadata（verdict/reason、group scope ids、suppression categories）。它**不**记录
  reply body 或 memory 内容。

---

## 21. Consumer 矩阵

| Consumer | MB 关系 | Notes |
| --- | --- | --- |
| Single chat | 完整 `execute` / `finalize` + side-effect gates + reasoning | canonical |
| Group chat | `execute` / `finalize` + group memory policy | 有意的 scope 差异 |
| Role DM | `execute` / `finalize` | canonical |
| Home Node (mobile backend) | 同一 canonical core，local path | 无 MB 凭据 |
| Image Router | 仅决策（`imageMode`） | executor 是 Router |
| Active Companion | 当前未集成（无直接 MB 调用） | 当前事实 |
| Diary | 当前未集成（无直接 MB 调用） | 当前事实 |
| Moments | 当前未集成（无直接 MB 调用） | 当前事实 |
| Voice | integrity bypass | 有意为之 |

"当前未集成" 描述的是当前实现。它并不定义永久的产品禁令。

---

## 22. Non-goals

Middle Brain 当前不拥有：

- character provider 选择；
- character model execution；
- role system-prompt authority；
- memory persistence 或 consolidation；
- tool execution；
- image execution；
- provider prompt cache、stable-prefix 构造、cache baselines，或 cache audit telemetry；
- 全局 side-effect execution。

Active Companion / Diary / Moments 当前的非集成状态本身并不定义永久禁令。面向用户的
surfaces 不在本架构的 ownership 之内。

---

## 23. Enforcement

Runtime 行为由针对性的 tests 强制；本文档是人类 canonical architecture
authority。不新增 Markdown parser。

| Concern | Key tests |
| --- | --- |
| Execution / convergence | `test_middle_brain_seam.js`, `test_middle_brain_convergence.js`, `test_middle_brain_convergence_counterproof.js` |
| Context / admission | `test_middle_brain_ctx.js`, `test_middle_brain_admission.js` |
| Integrity / side effects | `test_middle_brain_integrity.js`, `test_middle_brain_integrity_state.js`, `test_middle_brain_integrity_notice.js`, `test_middle_brain_side_effect_gate.js`, `test_middle_brain_calibration.js` |
| Configuration / enabled | `test_middle_brain_semantics.js`, `test_middle_brain_collapse.js` |
| Reasoning | `test_middle_brain_reasoning_effort.js` |
| Observability | `test_middle_brain_observability.js`, `test_middle_brain_trace.js` |
| Home Node assembly | `test_home_node_middle_brain_assembly.js` |

---

## 24. Historical References

历史文档描述实现演进。`MIDDLE_BRAIN.md` 描述当前架构；历史文件不再承载当前 authority。

- `docs/history/runtime/P11-3-MIDDLE-BRAIN-SEMANTICS-CLOSURE.md`
- `docs/history/runtime/CONTEXT-CONVERGENCE-C1-REPORT.md`
- `docs/history/runtime/P2-CONTEXT-CONVERGENCE-AUDIT.md`
- `docs/history/platform/ASTRA_READINESS_PHASE1.md`
- `docs/history/runtime/RUNTIME-STABILIZATION-P2-REPORT.md`
- `docs/history/runtime/RUNTIME-INTEGRATION-AUDIT-2026-09-08.md`
