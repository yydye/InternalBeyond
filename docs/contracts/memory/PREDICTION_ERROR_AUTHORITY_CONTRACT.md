# Prediction Error · Authority & Semantics Contract（v1 冻结提案 / DESIGN ONLY）

> 状态：**DESIGN / AUDIT / CONTRACT-FREEZE PROPOSAL**
> `IMPLEMENTATION = NONE` · `PRODUCTION_WIRING = NONE` · `DURABLE_WRITE = NONE`
> 本文件**不**改任何现有生产文件；它只提出要冻结的语义与 authority 边界。
>
> **P0 · Contract Reconciliation：COMPLETE**（见 §I）
> 六项 owner ruling 已登记 · 三处内部冲突已收口 · addendum (q) 已追加到冻结契约 ·
> GAP registry 已在册 · 守卫迁移已提前到 production wiring 之前。
>
> **P1 · OutcomeObservation Authority Core：COMPLETE**（见 §I.10）
> 纯核心已实现并有 84 条断言；`PRODUCTION_WIRING = NONE` · `SETTLEMENT_ENGINE = NONE` ·
> `EVIDENCE_MATCHER_INVOCATION = OFF`。
>
> **P1.5 · Runtime Seam Guard Migration：COMPLETE**（见 §I.11）
> 两个真实 governance bypass 已关闭（拼写 + token 大小写空转）；
> normalization + definition/wiring 分离 + 第二条 seam 对抗矩阵（36 条断言）。
>
> **P2 · Prediction Registry：COMPLETE**（见 §I.12）
> `PREDICTION_REGISTRY_LIVE = YES` · `REGISTRY_LIFETIME = SESSION_ONLY` ·
> `PROJECTION_IS_CONTENT_NON_EXPANSIVE = YES` · `CALLER_SUPPLIED_VALIDATED = INVALID`（已落地）。
>
> **P3 · Settlement Engine：COMPLETE**（见 §I.13）
> `SETTLEMENT_ENGINE_LIVE = YES` · 七状态 · `T8 = TOTAL FUNCTION` ·
> `PREDICTION_ERROR = ORDINAL_ONLY`（`predictionErrorMetric = null`）·
> `CALIBRATION_APPLIED_TO_LIVE = NO`。
>
> **P4 · Calibration Ledger：COMPLETE**（见 §I.14）
> `CALIBRATION_LEDGER_LIVE = YES` · `LIFETIME = SESSION_ONLY` ·
> 分区隔离（`predictionType × targetDomain`）· `GLOBAL_PREDICTION_ACCURACY = FORBIDDEN` ·
> `calibrationConfidence = null`（契约冻结）· **零写回**。
>
> **P4-R1 · Calibration Reconciliation：COMPLETE（见 §I.15）→ `P4_FREEZE = FROZEN`**
> `capabilityCoverage` 三维正交 · `P3_REACHABILITY_GATE = YES` ·
> `MULTI_DOMAIN_CALIBRATION = NO_V1` · `NEW_RUNTIME_SEAMS = 0`。
>
> **P5-B · Evidence Matcher：COMPLETE**（见 §I.16）
> `EVIDENCE_MATCHER_ROLE = ADVISORY_SEMANTIC_CLASSIFIER_ONLY` ·
> `EVIDENCE_MATCHER_ENABLED_DEFAULT = false`（生产零新增调用）·
> source / domain / predictionType 不可升级 · failure ⇒ `ambiguous`。
>
> **P5-B-R1 · Matcher Enablement Closure：COMPLETE（见 §I.17）→ `P5_B_FREEZE = FROZEN`**
> 三层 capability（compiled ≠ enabled ≠ production-settleable）· 具名 gap 原因 ·
> `MATCHER_AT_MOST_ONCE_PER_MATCH_KEY_WITHIN_SESSION` · `MATCHER_CALL_BUDGET = HARD_CEILING` ·
> `MATCHER_INPUT_TOP_LEVEL_KEY_COUNT = 5` · `NEW_RUNTIME_SEAMS = 0`。
>
> **P5-B2 · BehaviorEffect Attribution Authority：COMPLETE**（见 §I.18）
> `ABSENCE_OF_EFFECT_RECORD != KNOWN_NO_EFFECT` ·
> `KNOWN_NONE_REQUIRES_COMPLETE_COVERAGE = YES` ·
> authority = `RUNTIME_BEHAVIOR_EFFECT`（ONE EFFECT FACT OWNER）·
> `EVIDENCE_MATCHER_ENABLED_DEFAULT = false`（**保持**）。
>
> **P5-B3-A · Attribution Coverage Closure：COMPLETE**（见 §I.19）
> active authority ≠ history retention · `CAPACITY_EVICTION_IS_OBSERVED_TERMINATION = YES` ·
> `ATTRIBUTION_COVERAGE_READY = YES` · `EVIDENCE_MATCHER_ENABLED_DEFAULT = false`（**保持**）。
> `NEXT_ALLOWED_PHASE = P5-B3-B`（OutcomeObservation Production Authority；**未**进入）。
>
> 定位：R4 正向链（`Memory → Recall → Interpretation → Expectation → BehaviorEffect`）
> 之后的**反馈回路**契约。它**不是**新的一层（见 `RECONSTRUCTIVE_MEMORY_CONTRACT.md`
> §3.1 / §28：Prediction Error = L5 的 revision feedback signal，**不是** layer）。
>
> 与既有 contract 的关系：
> - 层边界、`predictionSnapshot`、`Prediction Error ≠ canonical mutation`、I18/I20/I21/I22
>   —— 由 [`RECONSTRUCTIVE_MEMORY_CONTRACT.md`](./RECONSTRUCTIVE_MEMORY_CONTRACT.md) 冻结，
>     本文件**只继承、不重开**。
> - 本文档新增的只有一件事：**把"later observation authority"闭合**
>   —— 即 R4-D 的 runtime 自己登记的 blocker：
>     `services/home-node/runtime-expectation.js:513`
>     `predictionErrorBlocker: 'LATER_OBSERVATION_AUTHORITY_NOT_CLOSED'`。

---

## 0 · 结论摘要（先给判断，再给证据）

### 0.1 审计的核心结论：Prediction Error 今天**不可能**被实现，原因不是缺算法，而是缺四个前提

| # | 缺失前提 | 机械证据 | 后果 |
| --- | --- | --- | --- |
| B1 | Expectation **没有稳定 id** | `expectation-shadow-core.js` 的 item 无 `expectationId`；`prediction-observation-core.js:269` `coreGeneratedExpectationId:false`、`:388` `expectationIdAssignment:'EXTERNAL_ID_REQUIRED_FOR_LINKED_SETTLEMENT'` | 预测不是"可寻址对象" ⇒ 无法与后来发生的事建立 linkage ⇒ **无法结算** |
| B2 | Expectation 内容**结构性不可读** | `runtime-expectation.js:507-508` `contentExposed:'NO'` / `browserVisible:'NO'`；模块**不导出**任何返回正文的入口（`:36-38`） | 没有 Prediction Registry 的输入面；唯一副本活在进程内 `held`（`:59-60`，64 条 / 10 min） |
| B3 | **没有 outcome observation 面** | `prediction-observation-core.js:82` `LIVE_CANONICAL_SOURCE_BINDING='NOT_IMPLEMENTED'`；`:385` `durableObservation:'NOT_IMPLEMENTED_R4D'`；`runtime-expectation.js:514` `liveCanonicalSourceBinding:'NOT_IMPLEMENTED'` | 没有任何"后来真实发生了什么"进入系统的通道 |
| B4 | **Settlement authority 无主** | `prediction-observation-core.js:69` `OUTCOME_JUDGEMENT_RUNTIME='CALLER_VALIDATED_PROTOCOL_ONLY'`；`:255` / `:251` 只检查调用方自报的 `judgement.validated === true` | 调用方（含模型）**可以自证** confirmed/contradicted ⇒ 正是本轮要消灭的洞 |

### 0.2 审计的第二个结论：现有 `prediction-observation-core.js` 的 vocabulary 与本轮目标**冲突**

`assets/js/memory-recall/prediction-observation-core.js:34` 冻结了

```
RESULTS = ['confirmed', 'contradicted', 'partial', 'unknown', 'unsettled']
```

这五个词正是本轮要求**避免**的语义（"matched ≠ 永恒事实 / missed ≠ Memory 被推翻"）。
本文件的处理方式**不是删除它**，而是：

- **R4-D.2 协议面保留逐字节冻结**（它已经被测试钉住：`test_expectation_shadow.js`、
  `test_counterfactual_shadow.js`、`test_reconstructive_memory_contract.js`）；
- 新增的 **Settlement Engine 是唯一 settlement authority**，它产出本文档定义的新状态集；
- `prediction-observation-core.js` 从"结算者"**降级为**"快照完整性 + linkage 谓词"，
  它的 `judgement.validated` 从"调用方可声明的布尔"改为"只能由 Settlement Engine
  的 module-private 能力产生"（见 §B.6 / §G.4）。这条改动把 B4 的洞关掉，
  且**不需要**改动 D.2 的任何已冻结字段。

**另有一处冲突不在代码里、而在冻结契约本身**（`§28.2` 把 `confirmed/contradicted` 的判定
交给模型，与本轮硬要求 #3 直接冲突）—— 完整裁决见 **§0.7**，**必须先裁决它**，
否则本文件其余部分都建在一个自相矛盾的地基上。

### 0.3 审计的第三个结论：仓库里已经有三个**不是** settlement evidence 的相邻概念，必须分开

| 概念 | 出处 | 它回答 | 它**不是** |
| --- | --- | --- | --- |
| `evidence`（provenance block） | `runtime-interpretation.js:1039-1046`、`:1395-1403` | 这次派生绑定了哪些 canonical 行、revision 是多少 | 不是权威等级 |
| `evidenceState`（MetaMemory） | `metamemory-shadow.js:75-78` | 这条**记忆**的证据基础还活着吗（8 档，优先级闭集） | 不是"关于外部世界的观察" |
| `Observation`（P26-2） | `docs/P26-2-OBSERVATION-CONTRACT.md:20` | **现在是什么**（只读状态快照） | 不是**发生了什么**、不是证据、无 confidence（`:101-109`）、不落库（`:148-151`）、明确"**不**实现 Feedback Loop"（`:207-213`） |

**由此得到本文件最重要的一个命名裁决**：本轮不能把新的证据载体叫 "Observation"，
否则会与 P26-2 已冻结的语义直接撞车。见 §D.0。

### 0.4 审计的第四个结论：`independentObservationCount` 是一个**永远为假**的闸门

`expectation-shadow-core.js:269` 的泛化门依赖 `context.independentObservationCount >= 2`。
但该字段**没有生产者**：

- 唯一传递链：`runtime-recall.js:820` ← `interpretationRes.independentObservationCount`
- `runtime-interpretation.js` 全文**不含** `independent` / `observation` 字样（已 grep 验证），
  其结果对象（`:1458-1480`）不设该字段 ⇒ 恒为 `undefined`
- ⇒ `Number(undefined)` = `NaN` ⇒ `isFinite` 假 ⇒ `independenceProven` **恒为 false**

**含义（对本轮很关键）**：仓库目前**没有**任何"多次独立观察"的机械原语。
因此"重复行为可以累积证据"（本轮要求 #7）在 v1 里**不能**被诚实实现为自动结算；
它只能被实现为**计数 + 门槛**，且门槛必须 fail-closed（见 §F.2 / §G.7）。

### 0.5 审计的第五个结论：BehaviorEffect **已经进了真实 prompt** ⇒ 自我实现风险**不是假设**

- `assets/js/communication.js:2823` / `:3255` 调用 `_ibPlaceBehaviorEffectMessage(...)`
- `assets/js/behavior-effect-render.js` 把 7 键效果渲染成**一条独立 system 消息**
- `services/home-node/runtime-behavior-effect.js:41-51`：`NEXT_ELIGIBLE_TURN`、一次性消费、
  进程内 64 / 600 000 ms、无持久账本

⇒ 系统**确实**会改变自己的行为，用户**确实**是在被影响之后才产生后续行为。
但今天 `behaviorEffectsApplied` **恒为 `[]`**（`expectation-shadow-core.js:321`、
`prediction-observation-core.js:327/333/338`），`behaviorInfluenceStatus` 只到
`'possible-unattributed'`。**本轮必须把它从 stub 变成 schema 的必需字段**（§D / §G.5）。

### 0.6 一句话推荐

> **v1 只做"把 authority 立起来"，不做"让它更聪明"**：
> 一个 deterministic、fail-closed、可审计的 `Prediction Registry + Authority Gate +
> Settlement Engine + ordinal Prediction Error + 只读 Calibration Ledger`，
> 且 `CALIBRATION_APPLIED_TO_LIVE = NO`（v1 只算不施加）。

### 0.7 与冻结契约的**一处实质冲突**：必须由本轮显式裁决，不能默不作声

`RECONSTRUCTIVE_MEMORY_CONTRACT.md` **§28.2（:2696-2707）** 明确把判定权交给模型：

```
| 判定                                   | 机械                    | 模型                    |
| result = confirmed / contradicted / partial | —                | ✅（**必须**结构化输出） |
| predictionError 的极性                  | 半（仅当有极性字段时）    | ✅（其余情形）           |
| predictionError 的幅度                  | —                       | ✅（**MUST NOT** 伪装成精确标量）|
| result = unknown（没有 observation / 证据不可见 / 丢失） | ✅ **fail-closed** | —          |
```

而**本轮要求 #3 是硬要求**：`LLM 不拥有最终 settlement authority`。

⇒ 唯一的正确处置是**显式收窄（narrowing）**，并登记为一次 supersession：

```
§28.2 的 "模型负责 confirmed/contradicted/partial"  → 由本文件 §B.3 / §E 取代
MODEL_ROLE_CHANGE           = DECIDES  →  ADVISES
MODEL_STILL_MAY_OUTPUT      = support | conflict | irrelevant | ambiguous
                            + strengthHint(weak|moderate|strong) + rationale + evidenceRefs
SETTLEMENT_STATE_AUTHORITY   = DETERMINISTIC_POLICY_ENGINE
DIRECTION_OF_CHANGE          = NARROWING（收窄模型 authority）
CONTRACT_COMPATIBILITY       = 收窄是安全的；放宽才需要重新论证
```

**注意**：`predictionError` 的**幅度**在 §28.2 里被允许由模型给出（只要不伪装成精确标量）。
本文件进一步**收窄**为：幅度**只**由确定性查表产出（§F.6），模型连 ordinal magnitude 都不产。
理由：幅度一旦由模型给出，就等于让模型用另一个名字宣布"错得有多离谱"，
而 `matched/missed` 恰恰是它不被允许宣布的东西 —— 两者必须是同一种 authority。

同一节里还有一条**对实现更严格的既有冻结**，本文件的 D.2 必须服从：

```
§28.1（:2688）  evidenceMemoryId = 该 outcome 对应的**新 canonical event**（机械·外键）
§28.2（:2701）  result=unknown 必须 fail-closed
§28.3（:2709-2716） Prediction settlement MUST NOT 修改 canonical event；
                    MUST NOT 写回 memory_records；新结果**作为新的 L0 event 追加**（§3.2）
§28.4（:2732-2735） Prediction Error = expectation revision 的信号，不是 canonical mutation；
                    旧 canonical memory **必须逐字节不变**
§31（:2821-2831） behaviorEffectsApplied[] / selfInfluencePossible / attributionConfidence
                    三者必须可表达；selfInfluencePossible===true **MUST NOT** 计入独立确认
§32（:2846-2859） NO SELF-REINFORCING CONFIDENCE LOOP；calibrationEvidence MUST 是跨 expectation
                    的机械汇总，MUST NOT 由模型产生，MUST NOT 回写成 subjectiveConfidence
§33.1（:2877-2884）NO TRACE OVEREXPOSURE：expectation 默认不进 UI / 日志正文 / export
§34.1（:2913-2918）若 durable ⇒ Home Node single writer；MUST NOT 双 authority
§34.2（:2920-2930）若 durable ⇒ MUST NOT 塞进 canonical memory payload；
                    候选是独立 sibling store / feed（复用 understandings 的双 revision 模式）
§39（:3076-3112）  §28.3 的不变式由**逐字节比对**强制执行
```

**由此得到一条今天**未被强制**的契约要求（新发现）**：

```
§28.1 要求 evidenceMemoryId 指向"该 outcome 对应的**新** canonical event"
现状：prediction-observation-core.js:161-205 的 builder 接受**调用方给的任意 record**，
      只校验 id 存在且在授权集内，**不校验它比 prediction 更新**。
⇒ OBSERVATION_MUST_POSTDATE_PREDICTION = NOT_ENFORCED（今天）
本文件：见 §D.1 temporalValidity 与 §E.2 T2 —— 必须强制。
```

### 0.8 对 §28.1 "结算时冻结" 字面的精化

契约 §28.1（:2693-2694）说 `predictionSnapshot` **MUST** 是**结算时**冻结的副本，
理由是"拿当前 prediction 去和结果比会产生假的 prediction error"。

本文件把这一条**精化**为两个快照（更严，且不违契约）：

```
predictionSnapshotAtCreation    建档时的预测副本 —— **判定一律用它**
predictionSnapshotAtSettlement  结算时的预测副本 —— 仅作审计
若二者不同 ⇒ expectationRevizedDuringWindow = true ⇒ 该次结算必须标记
              （§E.2 T7），且**不得**计入 calibration 的独立确认
```

理由：要诚实地度量 prediction error，比较对象**必须**是"当时真的预测了什么"；
用结算时的（可能已被修订的）副本去比，反而会抹掉"预测中途被改过"这件事。

### 0.9 实现约束清单（21 条审计事实 + 1 条陈旧自述，必须在设计期就服从）

这些是独立审计（R4 链路 / Observation / Memory authority / 冻结契约）发现、且**必须在设计期就服从**的事实。
每条给出"设计后果"，避免落地时才撞墙。编号 C7–C27 续 §A.4 的 C1–C6。

| # | 事实（file:line） | 对设计后果 |
| --- | --- | --- |
| C7 | **没有任何 durable 认知表**：`CREATE TABLE` 全仓 52 张，**无** expectation / prediction / observation / interpretation 表 | v1 Prediction Registry **必须是进程内、有界、不落盘**（沿用 holder 纪律） |
| C8 | `tests/test_expectation_shadow.js:437-443` 断言这三个文件**零** `dbPut/dbGet/dbDelete/indexedDB/localStorage/writeFile`，且 `DB_VERSION=24` / `MEMORY_SCHEMA_VERSION=1` 不变 | **静默持久化会直接变红**，并且会让审计面说谎。要持久化必须显式修订这些自述 + 测试 |
| C9 | `tests/test_expectation_shadow.js:444-462` 扫描 assets/services/bridge/src-tauri，要求**除自述文件外**没有任何文件提及 `expectation-shadow-runner`；`runtime-interpretation.js:76-80` 说明 R4-C 守卫 grep **原始文本**（含注释） | 新模块**不得**在注释里写那两个 runner 文件名；接线必须**服务端**（照 `runtime-expectation.js` 的样子）而不是接浏览器影子 runner |
| C10 | `independentObservationCount` **无生产者**（`runtime-interpretation.js:1458-1480` 无该字段）⇒ `independenceProven` 恒 `false`（`expectation-shadow-core.js:269`） | **v1 绝对不许写这个字段**。一旦填入，`independenceProven` 第一次变 `true`，在没改 `validateResponse` 的情况下改变了 L5 的 schema 含义。且**不得**用"被结算的 PE"去派生它（自我确认） |
| C11 | `behaviorEffectsApplied` 有两个**互不相连**的空槽（`expectation-shadow-core.js:321-322`、`prediction-observation-core.js:323-340`），而 live L5 结果**两个都没有** | 必须**一次裁决**：只有一个权威能填它。本文件指定 Registry（§C.1 ⑨）为唯一填点，并同步 D.2 槽位的语义（§B.6） |
| C12 | 契约 §31 `:2821` + §39 `:3090`：`behaviorEffectsApplied` 非空时**不得**计独立确认 | contaminationGate 必须**机械**读这个数组，不是读 `behaviorInfluenceStatus` 字串 |
| C13 | `prediction-observation-core.js:109-111` 的能力原语是 module-private `WeakSet`/`WeakMap` ⇒ **跨模块实例/跨进程会失效** | OutcomeObservation 的 builder 与 verifier **必须在同一次模块加载里** ⇒ 决定：Registry / Observation / Settlement **全部在 Home Node 进程内**（§H.2） |
| C14 | live expectation 内容**结构性不可读**（`runtime-expectation.js:35-40`、`:507-508`），但 `settle()` 需要 `expectation.prediction`（`:270`）与 `expectationId`（`:268`） | Registry 必须**在拥有 `held` 的那个进程内**、作为**内部 seam** 接出（不经路由、不进响应、不破坏"无内容 API"）——这是一次需要显式论证的窄改动 |
| C15 | 成本包线冻结：解释 1 + 期望 1 + 行为 0 = 2；`thirdPolicyBit:'NOT_ADDED'`；`runtime-cognitive-policy.js:40` 与 `http.js:833-835` 都是闭集 | **v1 不得新增任何模型调用**（Evidence Matcher 默认 OFF）⇒ 不需要第三个策略位 |
| C16 | `tests/test_expectation_shadow.js:470-477` 断言 recall 的 result/trace/meta JSON **不含** `expectation` / `prediction` 子串；17 键信封形状被断言 | 结算面**不得**搭 recall 信封；必须是**独立边界**。任何把 `prediction*` 塞进 recall 响应的做法都是契约变更 |
| C17 | `runtime-interpretation.js` 从不给 `buildRequest` 传 `evidence` map ⇒ live 下 `systemEvidenceState` **恒 `null`**；`CONSUMABLE_EVIDENCE_STATES` 只在测试里被走过 | 不要把 Observation Authority 建在 `systemEvidenceState` 上；本文件的 `source` 闭集是**新的、独立的**权威轴（§D.2），不是它的翻版 |
| C18 | `expectation-shadow-core.js` 的 `duplicateMemoryId` / `interpretationUnavailable` 两个 reason code **声明但从不 push**（死码）；`EXPECTATION_WITHOUT_INTERPRETATION='CREATED_DEGRADED'` **无实现**（`:349-352` 直接硬失败） | 不要复用这两个码作为新语义；也不要把 `CREATED_DEGRADED` 当成已存在的行为 |
| C19 | §25.1（`:2599-2607`）：`triggerPattern` **MUST** 是可机械识别的模式，**MUST NOT** 是一句自由文本 | **支持** §C.0 的裁决：结构化预测必须靠 schema 扩展，不能靠运行时解析自由文本 |
| C20 | §25.1 第 2 点（`:2601-2602`）+ §26（`:2627`）：**校准统计不得放在单条 Expectation 上**（它是跨记录量） | Calibration **必须**是独立账本（§H.2 ③），不得塞进 PredictionRecord |
| C21 | (k-7)（`:1886-1889`）：runtime-only expectation **不得**生成"看似永久、reload 后失效"的 id | `predictionId` **必须**带显式 `idLifetime:'SESSION_ONLY'`（§H.2） |
| C22 | §36（`:3037-3044`）：允许"行为影响先于预测"的**唯一前提**是从第一天就记录 §31 的三字段，否则「§32 的 NO SELF-REINFORCING CONFIDENCE LOOP 在**结构上无法**成立」 | **该前提今天已被违反**：live 路径**一条都没记**（§A.6）。本文件把三字段列为必需（§C.1 ⑨ / §G.19），**正是**在补这个前提 |
| C23 | §35.2（`:2968-2982`）预测 **MUST NOT** 直接写 trust（`"他可能离开" → trust -= X` 被点名禁止）；§35.3（`:2992`）+ I4/I21（`:988,:1005`）expectation 进输出前**必须**过独立 disclosure 决策，而该决策 `authorize()` **无生产 caller**（PRODUCTION GAP） | ① relational 结算零写入（§F.4）；② **v1 的 Prediction Error 不得进入任何输出面**（GAP-1） |
| C24 | `runtime-seam-guard.js:113-115` 用 `indexOf('prediction-error')` 匹配 ⇒ 对 camelCase（`predictionErrorLive`，`runtime-recall.js:1549`）**不命中**；而 `test_r4f_live_behavior_effect.js:767-772` 正在断言该文件 `audit.ok === true` | **今天最可被利用的守卫洞**。相位迁移**必须**把匹配改为分隔符/大小写归一 + 补对抗样本（§H.4 T-G1） |
| C25 | `test_reconstructive_memory_contract.js:74` `FORBIDDEN_WIRING = []` ⇒ N1（`:251`）**永不失败**；而契约 §37（`:3055`）仍声称 production 面零引用。同一份冻结文件里对同一列表有**四处互相矛盾**的陈述（`:1404` / `:1815` / `:2069` / `:2323`） | 本文件的落地**不得**依赖该守卫提供任何保证（GAP-3） |
| C26 | `EXPECTATION_RUNTIME = PROTOCOL_ONLY` 已陈旧（L5 已 live），且**有测试在钉住这个陈旧命题**：`test_reconstructive_memory_contract.js:616-618` 断言 `docs/architecture/MEMORY.md:18` 的 `runtime 生产实现 = NONE` | 落地阶段必须把"哪些层已 live"的清单一次性对齐；否则新设计会照着一份**已知为假**的现状图施工 |
| C27 | 同一个量有两个名字：契约 §26（`:2627,:2635,:2858`）叫 `calibrationEvidence`，而 (k-6)/(k-11) 与**全部代码**叫 `calibrationConfidence`（grep `calibrationEvidence` 全仓 4 处，其中 1 处是文本存在性检查） | addendum (q) 必须**归一命名**，并明确"跨记录统计量"与"系统持有的校准置信度"是同一个量的两个名字，还是两个量（本文件按**同一量**处理） |

**另有一条**必须先解决的**陈旧自述**（会误导实现者）：

```
runtime-behavior-effect.js:394-396   live:'NO' / liveBlocker:'BROWSER_PROMPT_PLACEMENT_REQUIRES_USER_OWNED_FILE'
runtime-recall.js:1523-1524          promptPlacement:'NOT_INSTALLED'
                                       ↑ 与事实不符
communication.js:3251-3255 / :2821-2823   放置**已接线**（1v1 + 群聊）
behavior-effect-render.js:121-133         固定表 renderer，零插值
⇒ BEHAVIOR_EFFECT_REACHES_MODEL_PROMPT = YES（今天）
   STALE_SELF_DESCRIPTION_COUNT = 1（至少）
```
任何"行为干预不影响结果"的推理都建立在**错误**的自述上 ⇒ 本文件 §D.4 的污染闸门**必须默认假设干预已发生**。

---

## A · Existing-State Audit（基于当前仓库证据）

> 纪律：本节每一句都可回溯到 file:line。凡未经代码证实者，一律标注 **INFERENCE**（推断）
> 或 **ABSENT**（不存在，并给出所跑的 grep）。

### A.1 R4 正向链各层的当前 authority

| 层 | 生产文件 | 谁产生**内容** | 谁持有**权威** | durable? |
| --- | --- | --- | --- | --- |
| L0 canonical memory | `services/home-node/memory-store.js` | 用户 / 既有 producers | **Home Node**（browser IndexedDB 只是 mirror，`docs/architecture/MEMORY.md:69-73`） | YES |
| R4-B MetaMemory | `assets/js/memory-recall/metamemory-shadow.js` | **纯确定性投影** | 系统（模型从不产出 `evidenceState`） | NO（`:18` 不写任何 durable） |
| R4-C Interpretation | `memory-interpretation-core.js` + `runtime-interpretation.js` | **模型** | 系统（校验器 + 闭集 + 绑定） | NO（`:318` `durable:false`） |
| R4-D Expectation | `expectation-shadow-core.js` + `runtime-expectation.js` | **模型** | 系统（校验器 + 泛化门 + 独立性门） | NO（`:510` `durable:false`、`durableWrites:0`） |
| R4-F BehaviorEffect | `runtime-behavior-effect.js` + `behavior-effect-render.js` | **确定性规则**（0 次模型调用，`:83-84`） | 系统 | NO（`:49-51` `EVICTION_BOUNDED_NO_LEDGER`） |
| PROD-1 control plane | `runtime-policy.js` / `runtime-cognitive-policy.js` | 操作者 | **Home Node 认证内网路由**（`P21-R4-PROD-1-COGNITIVE-CONTROL-PLANE.md:26-27`） | YES（`runtime-policy.json`） |

**可直接复用的 authority 纪律（三条，全部是既有 house style）：**

1. **模型内容 ≠ 系统权威**：模型只能写"主观"字段，系统字段（`evidenceConfidence` /
   `calibrationConfidence` / `confidence`）出现即整条作废 ——
   `expectation-shadow-core.js:237-239`、`memory-interpretation-core.js:273-277`。
2. **闭集 + 优先级 + fail-closed**：`metamemory-shadow.js:48-78`（8 档证据状态，
   自上而下先命中先返回；判定失败 ⇒ `degraded`，`:211-214`）。
3. **没有冻结公式就不得造数值**：`metamemory-shadow.js:85-90`
   「仓库里**没有**冻结的数值公式，凭审美造 0.73 就是把无知伪装成精度」。
   → 直接支持本轮"error magnitude 先 ordinal、`predictionErrorMetric` 保持 `null`"。

### A.2 可复用的数据结构（逐字引用）

**Expectation item**（`expectation-shadow-core.js:270-279`）：

```
prediction                        string ≤500
trigger.kind                      ∈ TRIGGER_KINDS (:134)
trigger.label                     ≤200
evidenceMemoryIds[]               ⊆ 授权 id
contradictoryEvidenceIds[]        ⊆ 授权 id
generalizationLevel               'episode-hypothesis'（仅此级可达，:42-43）
independenceProven                bool（恒 false，见 A.5）
subjectivePredictionConfidence    0..1 | null   ← 模型所有
epistemicStatus                   'prediction'（系统写入，:48）
```

组装层再补（`:303-307`）：`generalizationCeiling` · `generalized:false` ·
`evidenceConfidence:null`（系统所有）· `calibrationConfidence:null`（系统所有）。

**Interpretation item**（`memory-interpretation-core.js:288-298`）：
`memoryId` · `meaning`(≤600) · `appraisal` ∈ `APPRAISALS`(`:50`) · `affect` ∈ `AFFECTS`(`:52`) ·
`relationshipMeaning?` · `causalAttribution?` · `basis` ∈ `MODEL_BASIS = ['ai_inference','ai_guess']`(`:47`) ·
`subjectiveConfidence` 0..1|null。

**BehaviorEffect**（`runtime-behavior-effect.js:106-108`）：**闭集 7 键**
`stance · strategy · initiativeTendency · rationaleCode · sourceTurn · derivedFrom · ttlTurns`，
`derivedFrom` 唯一合法值 `'L3_AND_L5'`（`:103`）；免费文本键被**具名**拒绝（`:113`）。

**MetaMemory evidence state**（`metamemory-shadow.js:75-78`）：8 档闭集
`unknown · degraded · evidence-lost · evidence-hidden · evidence-unavailable ·
evidence-unattested · attested · direct`。

### A.3 已经存在的 observation / feedback / evaluation 机制

| 机制 | 位置 | 状态 | 与本轮的关系 |
| --- | --- | --- | --- |
| P26-2 Observation | `assets/js/observation-core.js`（+ `docs/P26-2-OBSERVATION-CONTRACT.md`） | **有 1 个生产消费者**：`assets/js/activity/activity-runtime.js:146`（P27-3 集成） | **不能复用为 settlement evidence**（见 A.4） |
| P26-1 Domain Event | `docs/P26-1-DOMAIN-EVENT-CONTRACT.md` | foundation | 语义上最接近"发生了什么"，但 P26-2 §3 明确 event 亦**非 canonical** |
| P26-5 Feedback | `assets/js/feedback-core.js` | foundation，无生产接线 | 是"值得再看一眼"的信号，**不是**证据 |
| R4-D.2 Prediction Observation | `assets/js/memory-recall/prediction-observation-core.js` | **协议就绪 · 生产消费者 = 0**（grep 只命中 tests） | 本轮的**起点**：继承其快照完整性/能力原语，替换其 judgement 权威 |
| R4-B MetaMemory | `metamemory-shadow.js` | shadow，无 durable | 提供"证据语义只有一份"的纪律（`:29-33`） |
| Economy settlement | `docs`/tests `test_p22_6_economy_settlement.js` | 已实现 | **不同域**（结算的是交易而非预测），措辞需避免混淆 |

### A.4 与 Prediction Error **冲突**的地方（逐条）

**C1 · "Observation" 一词已经有两个互相冲突的含义，且**第三个**即将出现。**

- 含义①（P26-2）：`Observation = 某个 source 在某个时间点，对某个 domain/entity 当前状态的、
  可验证的描述`（`P26-2:20`）。**现在是什么**；无 confidence（`:101-109`）；
  **不**落库（`:148-151`）；**不**触发行为（`:36`）；**明确把 Feedback Loop 列为 non-goal**（`:211`）。
- 含义②（R4-D.2）：`buildCanonicalObservation(record, ctx)`（`prediction-observation-core.js:161`）
  从**一条 canonical memory 记录**派生 `observedOutcome = record.content|summary|title`（`:92`, `:183-202`）。
  ★ 这里的"observed outcome"其实是**把一条过去记忆重读一遍**，不是"后来真实发生了什么"。
  这在语义上就是本轮要修的东西：**用记忆当未来结果的证据**。
- ⇒ 裁决见 §D.0：新载体命名为 **Outcome Observation**（`oo_…`），并显式声明
  `P26_2_OBSERVATION != OUTCOME_OBSERVATION`。

**C2 · `prediction-observation-core.js` 的 judgement 权威是**自证**的。**

`:245-259` `normalizeJudgement` 只要求 `judgement.validated === true`（或 legacy
`d.judgementValidated === true`）。**没有任何东西**检查这个 `true` 是谁给的。
配合 `:69` `OUTCOME_JUDGEMENT_RUNTIME = 'CALLER_VALIDATED_PROTOCOL_ONLY'`，结论是：
**当前代码把 settlement authority 显式让给了调用方，而调用方可以是模型。**
这正是本轮要求 #3 要钉死的洞。

**C3 · `predictionError` 是离散的、且刻意不可比较。**

`:307-314` `predictionError = {kind:'discrete', result, metric:null, ...}`，
`:314` `predictionErrorMetric = null`，`:321` `calibrationConfidence = null`。
`:389` `calibrationConfidence:'NULL_UNTIL_SETTLED_HISTORY'`、
`:386` `numericPredictionError:'NOT_FROZEN'`。
**这是诚实的**，但也意味着"high confidence + miss ⇒ high prediction error"这个
本轮要求 #9 的语义**今天无法表达**（没有 magnitude 概念）。

**C4 · 自我实现风险已有字段，但全是 stub。**

`:323-340` 依据 `behaviorConsumerCount` 产出 `attribution`：
`behaviorInfluenceStatus ∈ {'not-evaluated','none-observed','possible-unattributed'}`，
`behaviorEffectsApplied` **恒 `[]`**，`attributionConfidence` **恒 `null`**。
⇒ 结构有了，**信息没有**。而 BehaviorEffect 已经进了真实 prompt（A.6）⇒ 风险是实的。

**C5 · 归一化/独立性原语缺失**（见 A.5）：`independentObservationCount` 无生产者。

**C6 · 硬编码的 token 禁令会挡住本轮接线。**

`tests/helpers/runtime-seam-guard.js:41-42`：

```
FORBIDDEN_EVERYWHERE       = ['counterfactual', 'prediction-error']
FORBIDDEN_IN_INTERPRETATION = ['expectation', 'behaviorEffect', 'counterfactual', 'prediction-error']
```

且 `tests/test-all.js:1729` 与 `:1769` 把 `PREDICTION ERROR 仍是 NO` 写成聚合套件的**事实断言**。
⇒ 本轮的**任何**接线都必须是一次**带注释的相位迁移**（repo 已确立的做法：
`P21-R4-PROD-1-COGNITIVE-CONTROL-PLANE.md:200-201`「两条守卫是带注释的相位迁移，不是放宽」），
并且必须**同时**给出"守卫仍然抓得住伪造"的对抗样本。

### A.5 独立性原语的审计（已 grep 验证）

```
grep -n "independent" services/home-node/runtime-interpretation.js   → 无匹配
grep -n "observation" services/home-node/runtime-interpretation.js   → 无匹配
```

全仓 `independentObservationCount` 只出现 4 处：`runtime-recall.js:820`（转发）、
`runtime-expectation.js:430`（转发）、`expectation-shadow-core.js:224`（消费）、
`expectation-shadow-runner.js:128`（影子 runner 转发）。

⇒ **结论（强）**：`independenceProven` 恒 `false`；
"多次独立观察"在仓库里**没有任何机械原语**。
这与 `expectation-shadow-core.js:44` 自己的声明一致：
`GENERALIZED_REQUIRES_REPO_EVIDENCE = 'no-independent-observation-primitive-exists'`。
**本轮的 preference/relational 策略必须建立在这个事实上，不得假设它已被解决。**

### A.6 干预是否已经真实发生（自我实现前提）

- `services/home-node/runtime-behavior-effect.js:41-46`：`NEXT_ELIGIBLE_TURN` · 一次性 ·
  持有者 64 / 600 000 ms · 只在进程内 · 不落盘。
- `assets/js/communication.js:2099-2126`：**冻结契约**
  `BEHAVIOR_EFFECT_PROMPT_PLACEMENT = DEDICATED_SYSTEM_ROLE_MESSAGE`；
  renderer 经既有 `createElement('script')` 动态装载（不改 `InternalBeyond.html`）。
- `assets/js/communication.js:2823`、`:3255`：两个放置点（1v1 与群聊）。
- `assets/js/behavior-effect-render.js:79`：
  `PRIORITY = 'SYSTEM_DEVELOPER_POLICY > EXPLICIT_USER_REQUEST > BOUNDED_BEHAVIOR_EFFECT_GUIDANCE'`。

⇒ **干预发生了** ⇒ 后续用户行为是**在干预之后**产生的 ⇒
`INTERVENTION_CONTAMINATION_TRACKING = REQUIRED`（§D / §G.5）。

**并且自述是陈旧的**（三处互相印证）：

```
runtime-behavior-effect.js:62          PREDICTION_ERROR_LIVE = NO          ← 仍成立
runtime-behavior-effect.js:64          R4F_BEHAVIOR_EFFECT_LIVE = NO       ← 与事实不符
runtime-behavior-effect.js:394-396     live:'NO' / liveBlocker:'BROWSER_PROMPT_PLACEMENT_REQUIRES_USER_OWNED_FILE'
runtime-recall.js:1523-1524            promptPlacement:'NOT_INSTALLED'      ← 与事实不符
test_r4f_live_behavior_effect_browser.js:793   R4F2_BEHAVIOR_EFFECT_LIVE = YES   ← 与事实相符
```
⇒ 本轮必须以**代码**为准，并在落地时同步修正这些自述。
任何"行为干预不会影响结果"的推理都建立在一份**已知为假**的现状图上。

### A.7 会与 Prediction Error 竞争 authority 的既有机制

| 机制 | 竞争点 | 本轮裁决 |
| --- | --- | --- |
| R4-D.2 `settle()` | 唯一现有 settlement 实现 | 降级为 linkage + 快照完整性；authority 移交 Settlement Engine（§B.6） |
| `subjectivePredictionConfidence` | 模型自报置信度 | **不变**；calibration **不得**覆写它（I22 三量分离） |
| `evidenceConfidence` | 系统持有的证据强度 | 保持 `null`；本轮**不**填它（没有冻结公式） |
| `calibrationConfidence` | 跨记录校准 | v1 **仍为 `null`**；只产出只读 Calibration Ledger（§H） |
| Understanding / relationship store | 关系判断的既有归属 | **FORBIDDEN**：relational prediction 的结算**不得**写它（§F.4 · §G.22） |
| Economy settlement | "settlement" 一词 | 命名上限定为 `PREDICTION_SETTLEMENT`，禁止跨域复用实现 |

### A.8 审计中发现的、与本轮无关但要诚实登记的既有问题

1. `runtime-behavior-effect.js:64` 的 `R4F_BEHAVIOR_EFFECT_LIVE = NO` 与浏览器相位事实不符（A.6）。
2. `expectation-shadow-core.js:77` / `counterfactual-shadow-core.js:447` /
   `prediction-observation-core.js:391` 仍写 `behaviorEffect:'NOT_IMPLEMENTED_R4F'`，
   而 R4-F 已实现；`test_counterfactual_shadow.js:594,613` 正在**断言这个陈旧值**。
   ⇒ 这是一个"测试锁住了过期事实"的实例；本轮**不改**它，但必须在落地阶段一并处理，
   否则任何对 STATE_SUPPORT 的修正都会误伤既有测试。

---

## B · Canonical Architecture

### B.0 全链路（唯一权威路径）

```
Expectation (L5 · 模型产生 · 已校验)
   │  ① 确定性投影（0 次模型调用、不读时钟、不读库）
   ▼
Prediction Registry  ─────────── 拥有 predictionId / 生命周期 / window / policy
   │                              ★ 唯一 mint id 的地方
   │  ② 现实继续发生
   ▼
Outcome Observation  ─────────── 由**授权 observer** 产出；
   │                             携带 source · domain · time · scope · interventionContext
   │  ③ 允许模型参与，但只输出**分类建议**
   ▼
Evidence Matcher  ───────────── {support | conflict | irrelevant | ambiguous}
   │                             + strengthHint + rationale + evidenceRefs
   │                             ★ ADVISORY ONLY（无 authority）
   │  ④ 确定性：ceilings × gates
   ▼
Authority Gate  ──────────────── 计算 admissibility（只降不升）
   │  ⑤ 确定性：状态机 + 类型策略
   ▼
Settlement Engine  ───────────── 产出 sealed Settlement Record（幂等、一次性）
   │  ⑥ 确定性：查表
   ▼
Prediction Error  ────────────── direction + ordinal magnitude（v1 无数值）
   │  ⑦ 确定性：有界、只读账本
   ▼
Calibration  ─────────────────── 只允许指向 Expectation confidence /
                                  Interpretation confidence
                                  ★ v1: CALIBRATION_APPLIED_TO_LIVE = NO
```

**禁止边（MUST NOT EXIST）**

```
Prediction Error ──✗──▶ canonical memory（memory_records / Understanding / moments / diary）
Prediction Error ──✗──▶ relationship / persona / speech style / tool policy
Prediction Error ──✗──▶ MemoryValue / recall score / cooldown / activation / seat / budget
Prediction Error ──✗──▶ 被结算的那条 prediction 自身的 confidence（自强化回路）
Settlement       ──✗──▶ 修改 predictionSnapshot（快照在建档时冻结）
Settlement       ──✗──▶ 修改 canonical event
Observation      ──✗──▶ 直接触发 BehaviorEffect / Capability / Authority / Wake
```

### B.1 每层的唯一职责与 authority

| # | 层 | 唯一职责 | 内容由谁产生 | authority 归属 | 明确**不做** |
| --- | --- | --- | --- | --- | --- |
| ① | Expectation（既有 L5） | 产生"接下来可能发生什么"的假设 | **模型** | 系统（校验器 + 泛化门 + 独立性门） | 不成为事实、不 durable、不改行为 |
| ② | **Prediction Registry** | 把一条已校验 expectation **投影**成可寻址、可结算的 Prediction record | **确定性投影** | **系统**（Home Node） | 不新增预测（绝不生成比 expectation 更多的内容）、不改写 expectation |
| ③ | **Outcome Observation** | 记录"关于某条 prediction，现实里发生了什么" | **授权 observer**（见 §D.2） | **系统**（observer 身份 + 授权等级） | 不是 P26-2 Observation、不是 Event、不是 Feedback、不触发行为 |
| ④ | **Evidence Matcher** | 把 observation 对 prediction 的**关系**分类 | **模型**（可选，v1 允许） | **无**（ADVISORY ONLY） | **绝不**产出 settlement state、绝不算 confidence |
| ⑤ | **Authority Gate** | 计算 admissibility（可达等级） | **确定性** | **系统** | 绝不"提升"等级；缺字段 ⇒ FORBIDDEN |
| ⑥ | **Settlement Engine** | 依据 admissibility + policy + opportunity 计算 settlement state | **确定性** | **系统**（唯一） | 不读时钟以外的隐式状态、不做自然语言判断、不写 canonical |
| ⑦ | **Prediction Error** | 把 settlement 折算成 direction + ordinal magnitude | **确定性查表** | **系统** | 不产出未冻结的数值 |
| ⑧ | **Calibration** | 累积 settled 历史，产出只读校准账本 | **确定性** | **系统** | v1 不写回任何 live 对象；永不写 Memory |

### B.2 三条权威的边界（model authority vs runtime authority vs operator authority）

**Model authority（允许）**

| 允许 | 层 | 依据 |
| --- | --- | --- |
| 产出 prediction 文本与 trigger | Expectation | 既有 R4-D（`:270-279`） |
| 产出 `subjectivePredictionConfidence` | Expectation | 既有 R4-D |
| 产出 evidence 关系分类 `support/conflict/irrelevant/ambiguous` | Evidence Matcher | **本轮新增** |
| 产出 `strengthHint ∈ {weak, moderate, strong}` | Evidence Matcher | **本轮新增**（离散，禁止数值） |
| 产出 `rationale`（有界）与 `evidenceRefs` | Evidence Matcher | **本轮新增** |

**Model authority（禁止 —— 全部是硬规则）**

```
MODEL_MAY_NOT  emit settlement state        （matched/missed/mixed/... 出现即丢整条）
MODEL_MAY_NOT  emit validated / confirmed / contradicted
MODEL_MAY_NOT  emit confidence of any kind  （evidenceConfidence / calibrationConfidence /
                                             settlementConfidence / numeric error）
MODEL_MAY_NOT  choose predictionType 或 settlementPolicy   ★ R2 裁决，见 §C.4 / §F.0
MODEL_MAY_NOT  choose contradictionMode
MODEL_MAY_NOT  emit opportunity existence   （opportunity 只能来自 canonical runtime）
MODEL_MAY_NOT  emit interventionContext     （contamination 由系统判定）
MODEL_MAY_NOT  emit 时间窗口 / expiry
MODEL_MAY_NOT  emit direction / magnitude of prediction error（连 ordinal 都不给）
```

**R2 的形式化（唯一权威）**

```
MODEL_MAY_NOT_CHOOSE_PREDICTION_TYPE = YES
MODEL_SUPPLIES   = subject.kind · predicate.kind · expectedOutcome.kind（三个闭集校验的语义）
SYSTEM_DERIVES   = predictionType → settlementPolicy → contradictionMode
无法唯一推导     ⇒ settleable = false（'prediction-type-ambiguous' / '-underivable'）
```

**Runtime authority（系统 = 唯一最终裁决者）**

```
SETTLEMENT_STATE_AUTHORITY        = DETERMINISTIC_POLICY_ENGINE
SETTLEMENT_ENGINE                  = services/home-node/runtime-prediction-settlement.js (提案)
ADMISSIBILITY_AUTHORITY            = DETERMINISTIC_AUTHORITY_GATE
OPPORTUNITY_AUTHORITY              = CANONICAL_RUNTIME_OBSERVER
PREDICTION_ID_AUTHORITY            = PREDICTION_REGISTRY
PREDICTION_TYPE_AUTHORITY          = DETERMINISTIC_DERIVATION_FROM_POLICY
CONTAMINATION_AUTHORITY            = SYSTEM（由 BehaviorEffect 账本 + observation 来源判定）
```

**Operator authority（唯一可配置面）**

```
新增策略位： autoPredictionSettlementEnabled（per character，默认 OFF）
依赖矩阵：  Expectation OFF ⇒ Settlement OFF（不得独立开启）
不得新增：  provider / credential / endpoint / memoryId / 成本第三位
```
（沿用 `P21-R4-PROD-1-COGNITIVE-CONTROL-PLANE.md:70-80` 的冻结矩阵与
`BEHAVIOR_EFFECT_INDEPENDENT_POLICY = NONE` 的处理方式：**没有**独立付费位。）

### B.3 三层分离：matching ≠ judgement ≠ settlement

R4-D.2 已经冻结了前两条（`prediction-observation-core.js:14-19`：
"matching ≠ judgement，两件事分开"）。本轮把它**扩成三条**：

| 判断 | 问题 | 归属 | 输出 |
| --- | --- | --- | --- |
| **Matching** | 这条 observation **被允许**用于这条 prediction 吗？ | 确定性（既有 `MATCHING_MODE_MATRIX`，`:40-57`） | `linkage` |
| **Judgement** | 它对 prediction 是**支持/冲突/无关/含糊**？ | **模型**（advisory） | `{relation, strengthHint, rationale, refs}` |
| **Settlement** | 这条 prediction 现在**结算成什么状态**？ | **确定性 Settlement Engine** | `settlementState` |

**冻结**：Judgement 的任何一个输出，**单独**都不足以决定 Settlement。
Settlement 必须同时满足：admissibility ∈ ELIGIBLE + opportunity 满足 + contradictionMode 允许
+ 时间在窗口内 + scope 匹配 + 未被 supersede。

### B.4 "只降不升"原则（本轮最重要的不变式）

```
effectiveAdmissibility = min(
    matrixCeiling(source, targetDomain),      // §D.3 表：上限
    scopeGate,                                // 主体/会话/角色匹配
    temporalGate,                             // 在 observation window 内
    opportunityGate,                          // 机会存在 + 机会被消费
    contaminationGate                         // §D.4 干预污染上限
)
```

- `matrixCeiling` 是**天花板不是授权**：任何其它闸门**只能降低**它；
- 任何闸门**输入缺失** ⇒ 该闸门取 **`FORBIDDEN`**（不是"跳过"）；
- ⇒ **fail-closed 是结构性成立的**，不依赖实现者的细心。

### B.5 状态可达性的静态边界（先声明，后实现）

```
SETTLEMENT_STATE_AUTHORITY       = DETERMINISTIC_POLICY_ENGINE
LIVE_SETTLEMENT                  = NOT_IMPLEMENTED_V1
DURABLE_SETTLEMENT_LEDGER        = NOT_IMPLEMENTED_V1
NUMERIC_PREDICTION_ERROR         = NOT_FROZEN（保持 null）
CALIBRATION_APPLIED_TO_LIVE      = NO
MEMORY_WRITE_FROM_PREDICTION     = FORBIDDEN
RELATIONSHIP_WRITE_FROM_SETTLEMENT = FORBIDDEN
```

### B.6 R4-D.2 的处置（不删除、不重开、明确降级）

| | 现在 | 本提案之后 |
| --- | --- | --- |
| `buildCanonicalObservation` | 唯一合法 observation builder | **保留**，但降级为 **snapshot-integrity builder**（它的 capability 原语 WeakSet/WeakMap `:109-111` 是本轮要复用的最好资产） |
| `MATCHING_MODE_MATRIX` | linkage 谓词 | **保留原样** |
| `OUTCOME_JUDGEMENT_MATRIX` / `OUTCOME_JUDGEMENT_RUNTIME` | `CALLER_VALIDATED_PROTOCOL_ONLY` | **保留字符串（冻结）**，但补充一条：`validated` 只能由 Settlement Engine 的 module-private 能力产生 |
| `settle()` | 结算主体 | **降级**：不再是 settlement authority；新 Engine 是 |
| `RESULTS = confirmed/contradicted/...` | 结算状态集 | **冻结为 legacy 协议词表**，新状态集不映射（见 §E.6） |
| `noSelfReinforcingUpdate` | 返回 `applied:false` | **保留**，作为"自强化回路禁止"的机械证据 |

**为什么不映射 legacy 别名（裁决）**：
`matched → confirmed` 之类的适配层会让 `confirmed` 这个词**继续在下游活着**，
正是本轮要根除的语义污染源。因此 v1 采 **`LEGACY_RESULT_ADAPTER = NONE`**（fail-closed）：
旧的 5 词表只属于 D.2 协议，新 Engine 不产出、不消费、不翻译。
若未来 D.2 真的出现生产消费者，再单独论证适配层 —— 那时它是一次**显式**的相位迁移。

---

## C · Prediction Schema（候选 canonical schema）

### C.0 前置裁决：**结构化预测需要一次受治理的 Expectation schema 扩展**

`expectation-shadow-core.js:270-279` 的 item 只有 `prediction`（自由文本 ≤500）、
`trigger{kind,label}`、`evidenceMemoryIds[]`、`contradictoryEvidenceIds[]`、
`generalizationLevel`、`subjectivePredictionConfidence`。

**一个确定的 Registry 无法从自由文本里"投影"出 subject / predicate / expectedOutcome。**
硬要在运行时解析自然语言 = 引入一个未申报的模型判断，正是本轮要禁止的。
⇒ 诚实裁决：

```
PREDICTION_STRUCTURE_REQUIRES_EXPECTATION_SCHEMA_EXTENSION = YES
EXPECTATION_SCHEMA_EXTENSION_IS_ADDITIVE                  = YES（不改已有字段语义）
EXPECTATION_SCHEMA_EXTENSION_IS_OPTIONAL_FOR_L5           = YES（不填 ⇒ expectation 照旧有效）
UNSTRUCTURED_EXPECTATION_SETTLEABLE                       = NO（fail-closed）
GOVERNED_PHASE_MIGRATION_REQUIRED                         = YES
```

代价必须说清：R4-D 纯核心与契约 §(k) 已被测试钉住
（`tests/test_expectation_shadow.js`、`tests/test_reconstructive_memory_contract.js` R4D1–R4D16），
因此这是一次**带注释的相位迁移**，不是随手加字段。

### C.1 `PredictionRecord`

```
PredictionRecord {
  // ── ① identity（唯一 mint 点 = Registry；确定性派生，无计数器 / 无随机 / 不读时钟）──
  predictionId            'pred_<stableToken>'          REQUIRED  system
  idLifetime              'SESSION_ONLY'                REQUIRED  system（R1：不伪装 durable）
  registrySessionRef      '<stableToken>' | null        REQUIRED  system（审计归属；**不是**持久化身份）
  registryVersion         'prediction-registry/v1'      REQUIRED  system

  // ── ② provenance（来源 expectation / interpretation / memory refs）──
  sourceExpectationRef {
    characterId, conversationId, turnId, expectationIndex        REQUIRED
  }
  sourceInterpretationRef {
    turnId, interpretationMemoryIds[]                             | null   // L3 是 OPTIONAL（L5 协议语义）
  }
  sourceMemoryRefs {
    evidenceMemoryIds[]            REQUIRED ≥1
    contradictoryEvidenceIds[]     REQUIRED（可为空数组）
  }

  // ── ③ settleable content（建档时冻结；此后只读 —— 契约 §28.1）──
  predictionSnapshot      string ≤500                   REQUIRED  冻结副本
  subject                 { kind ∈ SUBJECT_KINDS, label ≤80 }        REQUIRED
  predicate               { kind ∈ PREDICATE_KINDS }                 REQUIRED
  expectedOutcome         { kind ∈ OUTCOME_KINDS, token? ≤80, unit? } REQUIRED

  // ── ④ type & policy（**全部确定性派生；模型不得选择** —— R2）──
  predictionType          ← TYPE_TABLE[subject.kind, predicate.kind, expectedOutcome.kind]  DERIVED  system
  settlementPolicy        ← POLICY_TABLE[predictionType]                                    DERIVED  system
  contradictionMode       ← MODE_TABLE[predictionType][expectedOutcome.kind]                DERIVED  system
                            （再校验一次：✗ 格 ⇒ 建档即拒，defense in depth）

  // ── ⑤ confidence（三量分层，**不得共用一个 blob** —— I22）──
  subjectivePredictionConfidence   0..1 | null        ← 模型（原样搬运）
  evidenceConfidence               null               system（本轮不填）
  calibrationConfidence            null               system（v1 恒 null）

  // ── ⑥ window & opportunity（模型不得设置）──
  observationWindow {
    opensAt, closesAt      number                     REQUIRED  system-derived
    windowKind             'explicit-cue'|'elapsed'|'session'|'turn-bounded'
    timeAuthority          'SYSTEM_DERIVED'
  }
  opportunity {
    required               bool                       DERIVED
    kind                   'exclusive-choice' | 'displayed-prompt' | 'utterance-slot'
                         | 'elapsed-window' | 'runtime-execution' | 'none'
    existenceAuthority     'CANONICAL_RUNTIME'        （唯一合法值）
    consumedAt             number | null              （由 observation 回填）
    consumedByObservationId string | null
  }

  // ── ⑦ lifecycle ──
  lifecycleState          'open' | 'settled' | 'superseded' | 'withdrawn'
  settlementState         'pending' | 'matched' | 'missed' | 'mixed'
                        | 'expired_unobserved' | 'unresolvable' | 'superseded'
  createdAt               number
  settledAt               number | null

  // ── ⑧ scope ──
  scope { characterId, conversationId, subjectKind, subjectLabel }

  // ── ⑨ intervention（§G.5）──
  behaviorEffectsInForce  [ { sourceTurn, stance, strategy, initiativeTendency, rationaleCode } ]
  predictionInfluencedSystem  bool | null

  // ── ⑩ audit ──
  reasonCodes             string[]
  gateTrace               object（§D.6）
}
```

**闭集（v1）**

```
SUBJECT_KINDS    = ['character-self', 'user', 'third-party', 'system', 'world']
PREDICATE_KINDS  = [
  'will-do',             // 主体将执行某动作
  'will-not-do',         // 主体将不执行某动作
  'will-occur',          // 事件将发生（主体可为 world / system）
  'is-in-state',         // 主体处于某（时间受限的）状态
  'prefers',             // 主体对某物偏好
  'holds-stance',        // 主体对某**非关系对象**（话题 / 观点 / 事物）持有立场
  'relationship-state',  // 主体与角色的关系**处于**某状态   ┐ R2：relational 必须可被机械区分
  'relationship-change'  // 主体与角色的关系**将发生**变化   ┘
]
OUTCOME_KINDS    = ['exclusive-outcome', 'threshold', 'state-claim', 'denial-claim', 'window-occurrence']
```

**`relationship-*` 两个谓词是 R2 要求的补口**：审计结论是 `holds-stance` **无法**无歧义覆盖
relational —— "对某话题的立场"与"对我们关系的判断"是**不同的对象**，
若共用一个谓词，`TYPE_TABLE` 就无法唯一推导。因此：

```
RELATIONAL_TRIGGER_PREDICATES = ['relationship-state', 'relationship-change']
holds-stance   ⇒ predicateClass 'evaluative'（**永不**映射到 relational）
```

⇒ "用户对我态度变暖"若被声明为 `is-in-state` 则归 `latent_state`（用户内心状态），
若被声明为 `relationship-state` 则归 `relational`。**两条路都同样保守**
（两者都只允许 explicit user report 结算），因此不存在"选一个更松的类型"的套利空间。

### C.2 `predictionId` 的派生（并顺手关掉 B1）

```
predictionId = 'pred_' + stableToken(
    characterId | conversationId | turnId | expectationIndex | predicateFingerprint
)
registrySessionRef = stableToken(characterId | conversationId | registryEpoch)
```

**R1 冻结的身份纪律**

```
PREDICTION_REGISTRY_LIFETIME  = SESSION_ONLY
DURABLE_PREDICTION_STORE      = NO_V1
CROSS_RESTART_EXACTLY_ONCE    = NO
RESTART_RECOVERY              = NONE
idLifetime                    = 'SESSION_ONLY'      // **显式**，写在 PredictionRecord 与 SettlementRecord 上
```

- **无计数器 / 无随机 / 不读时钟**（沿用 P26-2 §5 的身份纪律）。
- `registrySessionRef` 只用于**审计 ID 的 session 归属**，
  它**不是**持久化身份，也**不**引入任何 store（契约 (k-7) `:1886-1889`
  "runtime-only 期望**不生成**看似永久、reload 后失效的 id"）。
- **Registry 同时把 `predictionId` 作为 `expectationId` 交给 R4-D.2**：
  `po.settle(expectation, observation, { match:{ mode:'explicit-link',
  observationExpectationId: predictionId } })` 且 `expectation.expectationId = predictionId`。
  ⇒ 这**正好**满足 D.2 自己登记的
  `expectationIdAssignment:'EXTERNAL_ID_REQUIRED_FOR_LINKED_SETTLEMENT'`
  （`prediction-observation-core.js:388`），**不需要改 D.2 的任何字段**。

### C.3 模型只能"提议"、系统只能"派生"的字段边界

| 字段 | 模型可否产出 | 系统如何处置 |
| --- | --- | --- |
| `predictionSnapshot` | 是（= 原 `prediction` 文本） | 原样冻结，永不改写 |
| `predictionType` | **否**（R2 裁决） | 由 `TYPE_TABLE[subject.kind, predicate.kind, expectedOutcome.kind]` **唯一推导**；模型提供的 `predictionType` 视为 `unknown-field` ⇒ 整条作废 |
| `subject.kind` / `predicate.kind` / `expectedOutcome.kind` | 只能从闭集里选 | 出集合 ⇒ 作废（`predicate-kind-out-of-vocabulary`） |
| `subject.label` | 可（有界） | 只作**标签**，不参与任何判定 |
| `contradictionMode` | **否** | 由 `MODE_TABLE[type][outcomeKind]` 表派生（✗ 格 ⇒ 建档即拒） |
| `settlementPolicy` | **否** | 由 `POLICY_TABLE[type]` 表派生 |
| `observationWindow` | **否** | 由 `(type, trigger.kind)` 确定性派生 |
| `opportunity.*` | **否** | 存在性只能来自 CANONICAL_RUNTIME |
| `behaviorEffectsInForce` | **否** | 由 BehaviorEffect 账本回填 |
| `calibrationConfidence` | **否**（出现即作废） | v1 恒 `null` |

### C.4 `TYPE_TABLE`：predictionType 的唯一推导（R2 收口）

**R2 裁决**（消除本文件此前"模型从四值里选类型"与"模型不得选类型"的自相矛盾）：

```
MODEL_MAY_NOT_CHOOSE_PREDICTION_TYPE = YES
PREDICTION_TYPE_AUTHORITY            = DETERMINISTIC_DERIVATION_FROM_STRUCTURE
MODEL_SUPPLIES                       = subject.kind · predicate.kind · expectedOutcome.kind
                                       （三个**只受闭集校验**的结构化语义）
SYSTEM_DERIVES                       = predictionType → settlementPolicy → contradictionMode
```

**第一步：`predicate.kind` → `predicateClass`（纯函数，全表覆盖）**

| `predicate.kind` | `predicateClass` | 候选 `predictionType` |
| --- | --- | --- |
| `will-do` | `action` | `event` |
| `will-not-do` | `action` | `event` |
| `will-occur` | `occurrence` | `event` |
| `is-in-state` | `mental` | `latent_state` |
| `prefers` | `preference` | `preference` |
| `holds-stance` | `evaluative` | `preference` |
| `relationship-state` | `relational` | `relational` |
| `relationship-change` | `relational` | `relational` |

**第二步：`TYPE_TABLE`（三键 → 唯一类型；⟂ = 不可推导）**

`subject.kind` 的允许集逐类型收紧（防止把证据不足的主体塞进宽松类型）：

| `predicateClass` \\ `subject.kind` | character-self | user | third-party | system | world |
| --- | --- | --- | --- | --- | --- |
| `action` / `occurrence` | `event` | `event` | `event` | `event` | `event` |
| `preference` (prefers) | ⟂ | `preference` | ⟂ | ⟂ | ⟂ |
| `evaluative` (holds-stance) | ⟂ | `preference` | ⟂ | ⟂ | ⟂ |
| `mental` (is-in-state) | ⟂ | `latent_state` | ⟂ | ⟂ | ⟂ |
| `relational` | ⟂ | `relational` | ⟂ | ⟂ | ⟂ |

**第三步：`expectedOutcome.kind` 的合法性**（与 §F.0 的 `MODE_TABLE` 一致）

```
若 (predictionType, expectedOutcome.kind) 落在 MODE_TABLE 的 ✗ 格
⇒ settleable = false
   reasonCode = 'contradiction-mode-not-permitted-for-type'
```

**第四步：不可推导时的 fail-closed**

```
subject.kind ∉ SUBJECT_KINDS                    ⇒ settleable=false, 'subject-kind-out-of-vocabulary'
predicate.kind ∉ PREDICATE_KINDS                ⇒ settleable=false, 'predicate-kind-out-of-vocabulary'
subject.kind 不在该 predicateClass 的允许集内      ⇒ settleable=false, 'subject-kind-not-permitted-for-type'
expectedOutcome.kind ∉ OUTCOME_KINDS            ⇒ settleable=false, '...-out-of-vocabulary'
键 → >1 类型（防未来扩表引入歧义）                  ⇒ settleable=false, 'prediction-type-ambiguous'
键 → 0 类型                                       ⇒ settleable=false, 'prediction-type-underivable'
```

**三条不变式**

```
INV-T1  TYPE_TABLE 是**函数**：任一合法三键最多映射到一个类型（today: exactly one）
INV-T2  未提供结构化三键（或任一缺失）⇒ settleable = false（**禁止** NLP / 隐式解析 / 额外模型调用补齐）
INV-T3  模型**无法**通过挑选类型来间接挑选 settlement policy ——
        因为它不提供类型；类型完全由它提供的语义决定，
        而每类语义的 policy 是冻结表（§F.1–F.4）
```

**类型不可选的套利空间已关闭**：`event` 是四类里唯一允许自动 deterministic settlement 的。
若模型能自选类型，它可以把一个偏好预测标成 `event` 来换取更低门槛 ——
R2 之后这不成立：说"用户偏好 A"必须用 `prefers` 谓词，而 `prefers` **只**映射到 `preference`。

---

## D · Outcome Observation / Evidence Schema

### D.0 命名裁决：**不许叫 "Observation"**

`observation` 这个词在仓库里已经有**至少六个互不兼容的含义**（审计已逐条 grep 验证）：

| # | 含义 | 位置 | 冲突点 |
| --- | --- | --- | --- |
| ① | P26-2 只读现状快照 | `assets/js/observation-core.js` | 字段闭集不含任何 outcome 文本；**不能复用** |
| ② | R4-D.2 canonical snapshot | `prediction-observation-core.js:161-205` | 从**一条过去记忆**派生 `observedOutcome` |
| ③ | agent 规划的 observation bundle | `assets/js/agent-orchestration-core.js:129-150` | 会**复制正文**（与 ① 相反）；错误码字面量与 ① 重名 |
| ④ | **会驱动行为**的关系观察 | `assets/js/role-dm-core.js:460,485,505`（`relationDelta` → trust/affinity/familiarity） | durable + 改状态，与 ① 的"不触发行为"完全相反 |
| ⑤ | 测试用的 expected-vs-observed harness | `tests/astra-observation.js:174-181,226-265` | 自己就在算 agreement / fp / fn；**不是生产代码** |
| ⑥ | 独立证据实例计数 | `expectation-shadow-core.js:224` `independentObservationCount` | 契约已冻结"该原语不存在" |

**最硬的一条证据**：把 R4-D 的 observation 对象喂给 P26-2 的
`observation-core.js` 会被**双重拒绝** —— `unknown-field:observedOutcome` 等，
且 `forbidden-value-field:canonical`（因为 `'canonical'` 就在该文件的
`RESERVED_VALUE_FIELDS` 里，而 `prediction-observation-core.js:187` 正设 `canonical:true`）。

```
NAMING_RULING
  P26_2_OBSERVATION        = '现在是什么'（只读状态快照）      —— 本文件不改、不扩展
  OUTCOME_OBSERVATION      = '关于一条 prediction，现实里发生了什么'  —— 本轮新增
  OUTCOME_OBSERVATION_ID_PREFIX = 'oo_'
  P26_2_OBSERVATION != OUTCOME_OBSERVATION
  OUTCOME_OBSERVATION_IS_NOT  = Event | Feedback | Action | Command | Capability
```

**并且**：`assets/js/observation-core.js` **一个字都不改**。
理由（已核实）：`tests/test_p26_closure_guard.js:34` 冻结其**整文件 hash**，
`:75` 冻结其 5 函数 API，`:121-126` 冻结 `ALLOWED_CONSUMERS = ['assets/js/activity/activity-runtime.js']`；
`tests/test_observation_core.js` O15 断言 `ALLOWED_FIELDS` 不含任何正文槽。
⇒ 新载体必须是**新文件**（提案：`services/home-node/runtime-outcome-observation.js`
+ 纯核心 `assets/js/memory-recall/outcome-observation-core.js`）。

### D.1 `OutcomeObservation` schema

```
OutcomeObservation {
  // ── identity / integrity ──
  observationId       'oo_<stableToken>'               REQUIRED  确定性派生
  schemaVersion       'outcome-observation/v1'         REQUIRED

  // ── ① provenance（谁观察的）──
  source              ∈ SOURCES                        REQUIRED  §D.2
  sourceInstance      点分小写 producer id ≤80         REQUIRED  必须在授权注册表内
  producerAuthority   'AUTHORIZED_OBSERVER'            REQUIRED  由 core 写入

  // ── ② target domain（在观察什么）──
  targetDomain        ∈ DOMAINS                        REQUIRED  §D.2

  // ── ③ time ──
  observedAt          number（注入；core 不读时钟）      REQUIRED
  windowRef           { predictionId, opensAt, closesAt }  REQUIRED
  temporalValidity    'within-window' | 'before-window'
                    | 'after-window' | 'unknown'       REQUIRED（core 计算）
  completeness        'point' | 'full-window-attested' | 'unknown'  REQUIRED

  // ── ④ scope ──
  scope               { characterId, conversationId, subjectKind, subjectLabel }  REQUIRED

  // ── ⑤ payload（有界；**禁止**携带正文体 / 全量对象 / base64）──
  outcomeRef          { kind:'token',   token ≤80 }
                    | { kind:'numeric', value:number, unit ≤24 }
                    | { kind:'statement', statement ≤280 }        REQUIRED（三选一）
  evidenceRefs        [ canonical ref ≤200 ]            REQUIRED（可为空数组）

  // ── ⑥ intervention context（§G.5 —— 缺省 ⇒ 按 UNKNOWN 处理）──
  interventionContext {
    behaviorEffectsInForce [ { sourceTurn, stance, strategy, initiativeTendency, rationaleCode } ]
    predictionInfluencedSystem  bool | null
    contaminationClass    ∈ CONTAMINATION_CLASSES       REQUIRED
    contaminationBasis    string ≤120
  }

  // ── ⑦ audit ──
  reasonCodes         string[]
  fingerprintAuthority 'memory-contract.stableStringify'（沿用既有唯一序列化权威）
}
```

**闭集**

```
SOURCES = [
  'CANONICAL_RUNTIME',        // Home Node / tool / DB / provider 的权威结果
  'USER_BEHAVIOR',            // 用户实际动作（点击 / 发送 / 删除 / 消费）
  'EXPLICIT_USER_REPORT',     // 用户显式陈述
  'LINGUISTIC_EVIDENCE',      // 用户文本的语义证据（模型中介抽取）
  'MODEL_INFERENCE',          // 模型自己的推断
  'BEHAVIORAL_TELEMETRY'      // 回复长度 / 沉默 / 延迟 / 话题延续等派生统计
]

DOMAINS = [
  'runtime_state', 'user_behavior', 'user_preference',
  'user_emotion', 'user_intent', 'latent_state', 'relationship'
]

CONTAMINATION_CLASSES = ['NONE', 'POSSIBLE', 'LIKELY', 'DIRECT', 'UNKNOWN']
```

**字段来源纪律**：`interventionContext` 与 `completeness` 由**系统**回填；
`source` / `sourceInstance` / `targetDomain` 由**授权 observer** 声明，core 只校验闭集与注册表。
模型**不产出** OutcomeObservation 的任何字段。

### D.2 Observation Authority = source × target domain（**不是**全局排名）

**授权 observer 注册表**（`sourceInstance` 必须逐字命中；未知 ⇒ `FORBIDDEN`）：

| `source` | 授权 `sourceInstance` 形态（示例） |
| --- | --- |
| `CANONICAL_RUNTIME` | `runtime.delivery` · `runtime.popup` · `runtime.activity` · `runtime.payment` · `runtime.memory-store` |
| `USER_BEHAVIOR` | `ui.click` · `ui.compose` · `ui.dismiss` · `runtime.user-action` |
| `EXPLICIT_USER_REPORT` | `chat.user-utterance`（必须带"用户显式陈述"标记） |
| `LINGUISTIC_EVIDENCE` | `runtime.interpretation-evidence`（模型中介 ⇒ 上限被压） |
| `MODEL_INFERENCE` | （无授权实例 —— 恒 `FORBIDDEN`） |
| `BEHAVIORAL_TELEMETRY` | `runtime.behavior-stats`（v1 恒 `FORBIDDEN`） |

**Authority Matrix（`matrixCeiling`）**
`ELIGIBLE` = 可直接驱动 settlement；`SUPPORTING` = 只能做支持性证据，**单独不得**结算；
`CANDIDATE` = 只能成为观察候选（v1 无候选管线 ⇒ 等价于不可结算）；`FORBIDDEN` = 禁止参与 settlement。

| source ↓ \ domain → | runtime_state | user_behavior | user_preference | user_emotion | user_intent | latent_state | relationship |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **CANONICAL_RUNTIME** | **ELIGIBLE** | **ELIGIBLE** | SUPPORTING | FORBIDDEN | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| **USER_BEHAVIOR** | FORBIDDEN | **ELIGIBLE** | SUPPORTING | CANDIDATE | CANDIDATE | FORBIDDEN | SUPPORTING |
| **EXPLICIT_USER_REPORT** | FORBIDDEN | SUPPORTING | **ELIGIBLE** | **ELIGIBLE** | **ELIGIBLE** | **ELIGIBLE** | **ELIGIBLE** |
| **LINGUISTIC_EVIDENCE** | FORBIDDEN | CANDIDATE | SUPPORTING | SUPPORTING | SUPPORTING | FORBIDDEN | SUPPORTING |
| **MODEL_INFERENCE** | FORBIDDEN | FORBIDDEN | FORBIDDEN | FORBIDDEN | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| **BEHAVIORAL_TELEMETRY** | FORBIDDEN | FORBIDDEN | FORBIDDEN | FORBIDDEN | FORBIDDEN | FORBIDDEN | FORBIDDEN |

**矩阵的四条读法（每条都是硬规则）**

1. **矩阵是天花板，不是授权**：`effectiveAdmissibility = min(ceiling, scopeGate, temporalGate,
   opportunityGate, contaminationGate)`，其它闸门**只能降低**。
2. **观察能力必须匹配目标域**：`CANONICAL_RUNTIME` 权威地知道**系统状态**，
   但**不知道**用户在想什么；`USER_BEHAVIOR` 权威地知道**用户做了什么**，
   但**不知道**系统状态、也**推不出**内心状态。
3. **`MODEL_INFERENCE` 与 `BEHAVIORAL_TELEMETRY` 整行 `FORBIDDEN`**：
   不是"权重低"，而是**结构上不参与 settlement**。
   这直接斩断「用户没继续聊 → 用户失望 → matched」这类链：
   沉默/长度/延迟只能以 `BEHAVIORAL_TELEMETRY` 出现，而该行全禁。
4. **`EXPLICIT_USER_REPORT` 是主观域的最高权威**：用户是自己内心状态的唯一权威。
   代价必须诚实登记：

```
EXPLICIT_REPORT_IS_HIGHEST_AUTHORITY_FOR_SUBJECTIVE_DOMAINS = YES
USER_REPORT_SINCERITY_ASSESSMENT = NOT_ATTEMPTED
  ⇒ v1 无法识别反讽 / 玩笑 / 违心陈述。这是**声明过的限制**：
    它只会"相信用户"，绝不会"替用户发明"。
EXPLICIT_USER_REPORT ⊬ user_behavior（自述动作弱于遥测事实 ⇒ 只能 SUPPORTING）
```

5. **`targetDomain` 是"这条观察在谈什么"，不是"它能证明什么"**。
   同一条 `USER_BEHAVIOR` 观察谈 `user_behavior`（ELIGIBLE）与谈 `latent_state`（FORBIDDEN）
   是**两条不同的 observation**，observer 必须如实声明；谎报 `targetDomain` 不构成攻击面，
   因为 (§D.3) 的 gate 会独立复核 domain 与 `outcomeRef` 的一致性。

### D.3 Domain 一致性复核（确定性，不依赖 observer 诚实）

```
DOMAIN_PAYLOAD_CONSISTENCY
  targetDomain='runtime_state'      ⇒ outcomeRef.kind ∈ {token, numeric} 且 token 必须是已注册 runtime 状态词
  targetDomain='user_behavior'      ⇒ outcomeRef.kind ∈ {token, numeric} 且 token 必须是已注册动作词
  targetDomain ∈ 主观域集合           ⇒ outcomeRef.kind 必须 = 'statement'
                                      （主观域**不允许** token/numeric —— 防止"把 0.73 当情绪"）
  outcomeRef.kind='statement'       ⇒ 必须来自 EXPLICIT_USER_REPORT 或 LINGUISTIC_EVIDENCE
                                      （CANONICAL_RUNTIME 不得对主观域发 statement）
违反 ⇒ effectiveAdmissibility = FORBIDDEN，reasonCode = 'domain-payload-inconsistent'
```

### D.4 Intervention Contamination（§G.5 的机械实现）

`contaminationClass` 的判定顺序（先命中先返回，沿用 MetaMemory 的优先级纪律）：

| # | 条件 | class |
| --- | --- | --- |
| 1 | `interventionContext` 缺失或不可解析 | `UNKNOWN` |
| 2 | 观察由系统自身产生（如"我显示了弹窗"） | `DIRECT` |
| 3 | 被观察的结果是系统动作的直接下游（用户点了系统渲染的按钮） | `LIKELY` |
| 4 | 观察窗口内存在消费过的 BehaviorEffect，但无法证明因果 | `POSSIBLE` |
| 5 | 以上都不成立（窗口内无效果在生效） | `NONE` |

**污染闸门（区分"事实"与"含义"—— 本设计的关键区分）**

```
contaminationGate:
  class = NONE            ⇒ 不降级
  class = POSSIBLE        ⇒ 主观域上限降到 SUPPORTING；机制域不降级
  class = LIKELY | DIRECT ⇒ 主观域上限降到 SUPPORTING **且** 禁止 missed；
                            机制域（runtime_state / user_behavior）**不降级**
  class = UNKNOWN         ⇒ 主观域 FORBIDDEN；机制域上限降到 SUPPORTING
```

**为什么机制域不降级**：如果系统显示了一个弹窗、用户点了 Cancel，
那么"用户点了 Cancel"**仍然是事实**。污染破坏的是**从该事实到人的结论**
（"所以他讨厌这个功能"），不是事实本身。因此：

```
INTERVENTION_CONTAMINATION_INVALIDATES = 从行为到人的推论，不是行为事实
POPUP_CANCELS_POPUP_EVENT_PREDICTION   = 可以结算（event）
POPUP_CANCELS_PREFERENCE_PREDICTION    = 不得结算（preference ⇒ 最多 SUPPORTING）
```

### D.5 `EvidenceMatch`（模型可参与的唯一产物 —— ADVISORY ONLY）

```
EvidenceMatch {
  predictionId        REQUIRED
  observationId       REQUIRED
  relation            'support' | 'conflict' | 'irrelevant' | 'ambiguous'   REQUIRED
  strengthHint        'weak' | 'moderate' | 'strong'                        REQUIRED
  rationale           string ≤280                                          REQUIRED
  evidenceRefs        [ ≤200 ]                                             REQUIRED
  model               { providerClass, modelId, latencyMs, attempts }      system
  authority           'ADVISORY_ONLY'                                      system（不可被模型覆盖）
}
```

**硬规则**：`relation` 出闭集、或出现任何 settlement 状态 / 任何 confidence 字段
⇒ **整条 match 作废**（不是截断、不是降级）。
`EvidenceMatch` **不参与** settlement 判定 —— 它只进入 `gateTrace` 作为人类可读证据。
v1 甚至可以完全不调用它（`EVIDENCE_MATCHER_INVOCATION = OPTIONAL / DEFAULT OFF`），
settlement 仍必须能对纯机制型 prediction 完整工作。

### D.6 `AuthorityGate` 输出（`gateTrace`）

```
{
  predictionId, observationId,
  ceiling              : MATRIX[source][targetDomain],
  scopeGate            : 'MATCH' | 'SUBJECT-MISMATCH' | 'CONVERSATION-MISMATCH' | 'CHARACTER-MISMATCH',
  temporalGate         : temporalValidity,
  opportunityGate      : 'SATISFIED' | 'NOT-REQUIRED' | 'ABSENT' | 'NOT-CONSUMED' | 'UNKNOWN',
  contaminationGate    : contaminationClass,
  domainPayloadGate    : 'CONSISTENT' | 'INCONSISTENT',
  effectiveAdmissibility : 'ELIGIBLE' | 'SUPPORTING' | 'CANDIDATE' | 'FORBIDDEN',
  loweredBy            : [ ... 哪些闸门把它降下来了 ... ],
  reasonCodes          : [ ... ]
}
```

**`gateTrace` 是必需输出**：任何 settlement 状态都必须能在**不看模型、不看原始文本**的情况下
被审计复算 —— 这是"可审计"要求的机械落地。

---

## E · Settlement State Machine

### E.0 七个状态（取代 `confirmed / contradicted`）

```
SETTLEMENT_STATES = [
  'pending',            // 已建档，窗口未关；尚未形成允许的 decisive settlement
  'matched',            // 支持达门槛，且**无任何** opposing 证据
  'missed',             // 存在 decisive admissible conflict，且机会 / contradictionMode 全满足
  'mixed',              // 双向证据**同时存在**，且没有形成允许的 decisive settlement
  'expired_unobserved', // 窗口关闭，且**没有形成一个可用于结果结算的 completed opportunity**
  'unresolvable',       // 机会可能已完成（或不需要机会），但证据不足以判定
  'superseded'          // 窗口内被更晚的 prediction 取代，或预测本身被修订
]
```

**没有第八种状态**：`expired_unobserved` 的两种情形用 `reasonCodes` 区分 ——
`opportunity ABSENT → 'opportunity-absent'` · `opportunity NOT-CONSUMED → 'opportunity-not-consumed'`。

**五条语义断言（本文件的核心，必须逐条可测）**

```
E-A  matched  ≠ 某认知成为永恒事实
     matched 只表示：在 observationWindow 内、以该 prediction 的 expectedOutcome 为准、
     出现了达门槛的支持性观察。它**不**提升任何 memory / interpretation / relationship 的
     真值地位，**不**写 canonical，**不**产生 durable fact。

E-B  missed   ≠ 原 Memory 被推翻
     missed 只表示：该 prediction 的 expectedOutcome 在窗口内被**互斥观察**否定。
     它**不**修改、不删除、不降权任何 canonical memory（契约 §28.3 / §28.4）。

E-C  expired_unobserved 与 missed 是**两件不同的事**
     "没观察到" **MUST NOT** 变成 "missed"。
     唯一能把"观察到"变成负证据的形状是 window_closure_negative，
     且它**必须**带 completeness='full-window-attested' 且只对机制域可用（§E.2 T6）。

E-D  expired_unobserved 与 unresolvable 的判据是**机会是否完成**，不是结果
     expired_unobserved = window 已关闭，且**没有形成可用于结果结算的 completed opportunity**
     unresolvable       = 机会可能已 completed（或该 prediction 不需要机会），但**证据不足以判定**
     二者在聚合里 MUST NOT 被折叠成 missed（§G.9b）。
     ★ absence != missed：没有 completed opportunity **永远**不构成负证据。

E-E  mixed 的判据是"双向证据同时存在 **且没有形成允许的 decisive settlement**"，
     **不是**"双向都未达门槛" —— 后者会漏掉
     「support 达门槛 ∧ 存在 opposing SUPPORTING conflict」这一格。
     （§E.4 的行 3 是本次 P0 修复的核心。）
```

### E.1 生命周期与终态

```
lifecycleState : 'open' → 'settled' | 'superseded' | 'withdrawn'
settlementState: 'pending' 是唯一的非终态
终态 = matched | missed | mixed | expired_unobserved | unresolvable | superseded

SETTLEMENT_ONCE            = YES      // 一个 prediction 至多结算一次
RESETTLEMENT               = REJECTED // reasonCode 'already-settled'，状态不变
REOPEN                     = NOT_IMPLEMENTED_V1
POST_WINDOW_RETRO_SETTLE   = NO       // 窗口外证据不回溯结算（temporalValidity='after-window' ⇒ unresolvable）
```

### E.2 判定顺序（确定性；任一步失败**不改变**状态，只记 reasonCode）

| 步 | 闸门 | 失败 ⇒ | 说明 |
| --- | --- | --- | --- |
| T0 | prediction 存在且 `lifecycleState==='open'` | 无状态变化 | 已结算 ⇒ `already-settled` |
| T1 | **能力闸门**：observation 必须由 OutcomeObservation builder 产出（module-private seal） | `unresolvable`（`observation-not-built`） | 沿用 D.2 的 WeakSet/WeakMap 纪律；调用方**不能自证** |
| T2 | **时间闸门**：`observedAt > createdAt` 且落在 `observationWindow` 内 | `before-window` ⇒ 丢弃（保持 `pending`）<br>`after-window` ⇒ `unresolvable`（`evidence-after-window`） | **强制**契约 §28.1 的"新 canonical event"要求（今天未强制，见 §0.7） |
| T3 | **scope 闸门**：`characterId` + `conversationId` + `subjectKind` + `subjectLabel` 全部匹配 | 丢弃（不改变状态） | 跨角色 / 跨会话观察不得结算 |
| T4 | **authority 闸门**：`effectiveAdmissibility = min(ceiling, scope, temporal, opportunity, contamination, domainPayload)` | `FORBIDDEN` ⇒ 丢弃 | §D.2 / §D.3 |
| T5 | **机会闸门** | 见 §E.3 | |
| T6 | **完整性闸门**（仅 `window_closure_negative` 需要） | 不满足 ⇒ 降级为 `unresolvable` | 必须 `completeness='full-window-attested'` **且** `targetDomain ∈ {runtime_state, user_behavior}` |
| T7 | **修订闸门**：`predictionSnapshotAtSettlement === predictionSnapshotAtCreation` | 不等 ⇒ `superseded`（终态） | §0.8 |
| T8 | **状态计算**（§E.4 表） | — | |

### E.3 机会闸门（Opportunity Gating —— 回答"没观察到 ≠ missed"）

```
OpportunityState ∈ {
  'NOT-REQUIRED',   // 该 prediction 的结算不依赖机会（例如纯 runtime 状态）
  'SATISFIED',      // 机会已存在 **且** 已被消费
  'ABSENT',         // 机会从未存在（popup 根本没展示）
  'NOT-CONSUMED',   // 机会存在但从未被消费（展示了但用户没做出选择就离开）
  'UNKNOWN'         // 无法判定
}
```

判定规则：

```
opportunity.required === false                     ⇒ OpportunityState = NOT-REQUIRED
opportunity 存在性证据缺失                            ⇒ UNKNOWN
existenceAuthority ≠ 'CANONICAL_RUNTIME'           ⇒ UNKNOWN（模型/用户自述**不能**证明机会存在）
opportunity.consumedAt == null                     ⇒ ABSENT 或 NOT-CONSUMED
                                                      （依 existence 观察是否存在）
opportunity.consumedAt != null 且 scope 匹配        ⇒ SATISFIED
```

**硬规则**

```
G-OPP-1  模型 MUST NOT 产出 opportunity 存在性。机会只能由 CANONICAL_RUNTIME 观察。
G-OPP-2  ABSENT / NOT-CONSUMED / UNKNOWN ⇒ **禁止** missed。
G-OPP-3  ABSENT / NOT-CONSUMED ⇒ 窗口关闭时状态 = expired_unobserved。
G-OPP-4  UNKNOWN ⇒ 窗口关闭时状态 = unresolvable。
G-OPP-5  机会被消费是 missed 的**必要条件，不是充分条件**：
         还必须有满足 contradictionMode 的强负证据。
```

**用户给的例子（逐字落地）**

```
预测：弹窗出现后用户会点 Cancel
  ① 弹窗根本没出现
     ⇒ opportunity.existence = ABSENT
     ⇒ 终态 expired_unobserved（**不是** missed）
  ② 弹窗展示了，但用户没做出互斥选择就离开了
     ⇒ opportunity.existence = present，consumedAt == null ⇒ NOT-CONSUMED
     ⇒ 终态 expired_unobserved
  ③ 弹窗展示了，用户点了 Confirm（与 Cancel 互斥）
     ⇒ SATISFIED + exclusive_outcome 观察（USER_BEHAVIOR, ELIGIBLE）
     ⇒ 终态 missed
  ④ 弹窗展示了，用户点了 Cancel
     ⇒ SATISFIED + 支持性观察 ⇒ 终态 matched
        ★ 但污染闸门会记账：这是系统**自己**制造的互斥选择局面
          （contaminationClass ≥ LIKELY）⇒ 见 §D.4：事实可结算，
          但**不得**据此推出用户的偏好/心理状态。
```

### E.4 状态计算（T8 的唯一依据）—— 有序判定，先命中先返回

**输入量（全部由 T1–T7 之后的 artifact 机械决定）**

```
admitted         = effectiveAdmissibility ∈ {ELIGIBLE, SUPPORTING}
                   （CANDIDATE / FORBIDDEN **不计入** evidence；'irrelevant' 丢弃；
                     'ambiguous' 只进 gateTrace —— 既不算 support 也不算 conflict）

supportAll       = # admitted observations with relation='support'
conflictAll      = # admitted observations with relation='conflict'
conflictDecisive = # admitted conflicts 同时满足：
                     admissibility === 'ELIGIBLE'
                   ∧ contradictionMode 允许该形状
                   ∧ opportunity === 'SATISFIED'
matchedThresholdMet = POLICY_TABLE[predictionType].supportThresholdMet(supportAll)
                      （类型特定谓词；v1 实例见 §F.1–F.4）
windowClosed     = now ≥ observationWindow.closesAt
O                = OpportunityState ∈ {NOT-REQUIRED, SATISFIED, ABSENT, NOT-CONSUMED, UNKNOWN}
```

**判定（MUST 按此顺序；先命中先返回 ⇒ 唯一输出）**

| # | 条件 | 输出 |
| --- | --- | --- |
| 1 | `conflictDecisive ≥ 1` | **missed** |
| 2 | `matchedThresholdMet ∧ conflictAll == 0` | **matched** |
| 3 | `supportAll > 0 ∧ conflictAll > 0` | **mixed** |
| 4 | `supportAll > 0 ∨ conflictAll > 0`（单向，且上面三行都不命中） | `windowClosed` ? **unresolvable** : **pending** |
| 5 | `supportAll == 0 ∧ conflictAll == 0` | `¬windowClosed` ? **pending**<br>∶ `O ∈ {ABSENT, NOT-CONSUMED}` ? **expired_unobserved**<br>∶ **unresolvable** |

**状态空间闭合证明（穷举，替代旧表的"注意最后两行"式口头说明）**

第 3/4/5 行三个条件互斥且穷尽 `(supportAll > 0, conflictAll > 0)` 的全部四种取值：

```
(supportAll > 0, conflictAll > 0)  → 行 3  → mixed
(supportAll > 0, conflictAll == 0) → 行 4  → unresolvable / pending
(supportAll == 0, conflictAll > 0) → 行 4  → unresolvable / pending
(supportAll == 0, conflictAll == 0)→ 行 5  → pending / expired_unobserved / unresolvable
```

加上行 1（missed）与行 2（matched）的**前缀短路**，得到：

```
对所有合法输入组合，有且只有一个确定输出。  （E.4-TOTALITY）
```

**行 3 是本次 P0 修复的缺格。** 旧定义"双向都未达门槛"会漏掉
`matchedThresholdMet ∧ conflictAll > 0` 这一格。具体例：

```
用户明确说喜欢 A         → EXPLICIT_USER_REPORT × user_preference = ELIGIBLE  ⇒ support（达门槛）
某次实际行为选择了 B      → USER_BEHAVIOR × user_preference       = SUPPORTING ⇒ conflict（非 decisive）

旧表：不能 matched（conflict ≠ 0）· 不能 missed（无 decisive conflict）·
      也不满足"双向都未达门槛"（support 已达标）⇒ **无输出 = 缺格**
新表：行 1 不命中 → 行 2 不命中（conflictAll ≠ 0）→ **行 3 命中 = mixed**  ✔
```

**行 4/5 与机会的关系（E-D 的可测形式）**

```
有 evidence 但单向次门槛 ⇒ 行 4 ⇒ 窗口关闭时 unresolvable
     （**不是** expired_unobserved —— 因为已有可采证据，说明机会至少部分完成过）
无任何 evidence ⇒ 行 5 ⇒ 才去看机会：
     ABSENT / NOT-CONSUMED ⇒ expired_unobserved（没形成 completed opportunity）
     NOT-REQUIRED / SATISFIED ⇒ unresolvable（机会是有的，只是没有证据）
     UNKNOWN ⇒ unresolvable
     ★ 这两条正是 E-D 断言的机械形式，且 absence 在任何路径下都不产生 missed。
```

**测试设计（本轮只冻结设计，不写实现测试代码）**

```
T8-1  行 3 缺格样本（上例）⇒ 必须 mixed
T8-2  行 2：matchedThresholdMet ∧ conflictAll==0 ⇒ matched
T8-3  行 1 优先于行 2：decisive conflict 存在时即便 support 达门槛也 ⇒ missed
T8-4  行 4：单向次门槛 + 窗口关闭 ⇒ unresolvable；窗口未关 ⇒ pending
T8-5  行 5 三态：ABSENT ⇒ expired_unobserved · NOT-CONSUMED ⇒ expired_unobserved ·
      NOT-REQUIRED/SATISFIED ⇒ unresolvable
T8-6  totality：对 (supportAll>0, conflictAll>0, matchedThresholdMet, conflictDecisive>0,
      windowClosed, O) 的**全组合枚举**断言输出唯一且 ∈ SETTLEMENT_STATES
      （table-driven，覆盖 2×2×2×2×2×5 = 320 组）
```

### E.5 `reasonCodes` 闭集（Settlement 专用）

```
ok
prediction-not-found
already-settled
withdrawn
observation-not-built
observation-not-authorized-observer
observation-outside-window
evidence-before-window
evidence-after-window
scope-mismatch
authority-forbidden
matrix-ceiling-supporting-only
domain-payload-inconsistent
opportunity-absent
opportunity-not-consumed
opportunity-unknown
predicate-kind-out-of-vocabulary
subject-kind-not-permitted-for-type
prediction-type-ambiguous
prediction-type-underivable
contradiction-mode-none
contradiction-mode-not-permitted-for-type
window-closure-requires-full-attestation
window-closure-forbidden-for-subjective-domain
contamination-caps-subjective-domain
contamination-unknown
revision-detected
superseded-by-newer-prediction
behavior-accumulation-only-insufficient
threshold-not-reached
mixed-evidence
calibration-counted
calibration-excluded-contaminated
calibration-excluded-superseded
legacy-adapter-disabled
```

### E.6 与 R4-D.2 的关系（`LEGACY_RESULT_ADAPTER = NONE`）

```
NEW_STATE_AUTHORITY      = runtime-prediction-settlement（本文件 §B）
LEGACY_RESULTS           = ['confirmed','contradicted','partial','unknown','unsettled']
                           （prediction-observation-core.js:34 —— 冻结保留，但**只**属于 D.2 协议面）
LEGACY_RESULT_ADAPTER    = NONE
```

**不映射的理由**：`matched → confirmed` 会让 `confirmed` 继续在下游活着。
v1 采 fail-closed：新 Engine **不产出、不消费、不翻译**旧词表。
若未来 D.2 真的出现生产消费者，适配层必须单独论证并作为显式相位迁移加入。

**但** D.2 的 `judgement.validated` 必须被关上（§B.6）：新规则是
`validated:true` 只能由 Settlement Engine 的 module-private 能力产生，
调用方（含模型）**无法**声明。这是对 `CALLER_VALIDATED_PROTOCOL_ONLY` 的唯一修改。

---

## F · 四类 Prediction Policy

### F.0 `predictionType` 与 policy 的派生（**模型不选类型，也不选策略** —— R2）

```
PREDICTION_TYPES = ['event', 'preference', 'latent_state', 'relational']

MODEL_MAY_NOT_CHOOSE_PREDICTION_TYPE = YES          // R2 裁决
predictionType     = TYPE_TABLE[subject.kind, predicate.kind, expectedOutcome.kind]   // §C.4
settlementPolicy   = POLICY_TABLE[predictionType]   // §F.1–F.4
contradictionMode  = MODE_TABLE[predictionType][expectedOutcome.kind]
                     ↑ ✗ 格 ⇒ **建档即拒**（reasonCode 'contradiction-mode-not-permitted-for-type'）
无法唯一推导 ⇒ settleable = false（reasonCode 'prediction-type-ambiguous' / '-underivable'）
```

**这一步同时是**defense in depth**：**类型已由 §C.4 推导，`MODE_TABLE` 再校验一次；
两道都不通过 ⇒ 拒绝。`MODE_TABLE` 的 ✗ 格在 §C.4 第三步已经拦过一次，这里只是第二道。

**`MODE_TABLE`（`expectedOutcome.kind` → `contradictionMode`；`✗` = 该组合被拒）**

| `expectedOutcome.kind` ↓ \ type → | event | preference | latent_state | relational |
| --- | --- | --- | --- | --- |
| `exclusive-outcome` | `exclusive_outcome` | `exclusive_outcome`（**证据上限被压到 SUPPORTING** ⇒ 只能 `mixed`） | ✗ | ✗ |
| `threshold` | `threshold` | ✗ | ✗ | ✗ |
| `window-occurrence` | `window_closure_negative` | ✗ | ✗ | ✗ |
| `state-claim` | ✗ | `explicit_denial` | `explicit_denial` | `explicit_denial` |
| `denial-claim` | `explicit_denial` | `explicit_denial` | `explicit_denial` | `explicit_denial` |

```
CONTRADICTION_MODES = ['exclusive_outcome', 'threshold', 'explicit_denial',
                       'window_closure_negative', 'none']
```

### F.1 event（事件预测）

| 维度 | 裁决 |
| --- | --- |
| **strongest authority** | 系统/世界主体 ⇒ `CANONICAL_RUNTIME`（ELIGIBLE）；用户主体 ⇒ `USER_BEHAVIOR`（ELIGIBLE） |
| **allowed negative evidence** | `exclusive_outcome` ✅ · `explicit_denial` ✅ · `window_closure_negative` ✅（**须** `completeness='full-window-attested'` 且 `targetDomain ∈ {runtime_state, user_behavior}`）· `threshold` ✅ |
| **opportunity requirement** | 负方向 **REQUIRED**（`exclusive-choice` / `displayed-prompt` / `elapsed-window` / `runtime-execution`，存在性只能来自 `CANONICAL_RUNTIME`）；正方向不要求 |
| **settlement threshold** | `matched` = 1 条 ELIGIBLE 支持；`missed` = 机会 SATISFIED + 1 条满足 mode 的 ELIGIBLE 负证据 |
| **是否允许自动结算** | **YES**（四类中最高） —— 因为它最客观、最少解释空间 |
| **理由** | 事件预测的 expectedOutcome 是机制可判的；这正是"observation authority 可以闭合"的领域 |

### F.2 preference（偏好预测）

| 维度 | 裁决 |
| --- | --- |
| **strongest authority** | `EXPLICIT_USER_REPORT`（ELIGIBLE）。`USER_BEHAVIOR` 只能 SUPPORTING，且必须**跨不同机会**累积 |
| **allowed negative evidence** | `explicit_denial` ✅（唯一能产生 `missed` 的形状）。`exclusive_outcome` ⇒ 上限被压到 **SUPPORTING** ⇒ 最多 `mixed`，**绝不** `missed`。`window_closure_negative` ✗（**禁止**：没做某事不能反推不喜欢） |
| **opportunity requirement** | REQUIRED（正负都要）：偏好只能通过"有机会表达/行动"的场合被观察 |
| **settlement threshold** | `matched` = 1 条 EXPLICIT_USER_REPORT **或** `N_PREF = 3` 条**不同机会**的 USER_BEHAVIOR 支持且**零冲突**；`missed` = 1 条 EXPLICIT_USER_REPORT 的 explicit_denial |
| **是否允许自动结算** | **CONDITIONAL**：explicit report 分支 YES；行为累积分支由独立开关控制且 v1 **默认 OFF**（见下） |

```
N_PREF = 3
AUTO_SETTLE_PREFERENCE_FROM_BEHAVIOR = OFF      // v1 默认 OFF，fail-closed
```

**为什么行为分支默认 OFF（诚实登记）**：仓库**没有**"多次独立观察"的机械原语
（`expectation-shadow-core.js:44`：`no-independent-observation-primitive-exists`；§0.9 C10）。
v1 能做的最多是"**不同机会实例**"计数（`distinct (sourceInstance, observedAt, opportunityId)`），
这**不等同于**统计独立。因此：

```
支持性行为证据**照常累积并记录**（进入 gateTrace，可审计），
但该分支**不**自动升级为 matched；窗口关闭时状态 = unresolvable
（reasonCode 'behavior-accumulation-only-insufficient'）。
⇒ 单次行为永远不足以确认长期偏好（硬性满足本轮要求 #7）。
```

**绝不把该计数喂回 L5**：`supportingObservationCount` 是 Settlement Engine 的**局部**计数，
**MUST NOT** 写进 `independentObservationCount`（§0.9 C10：那会第一次翻转 `independenceProven`
并在未改 `validateResponse` 的情况下改变 L5 的语义）。

### F.3 latent_state（潜在心理状态预测）

| 维度 | 裁决 |
| --- | --- |
| **strongest authority** | `EXPLICIT_USER_REPORT` —— **且是唯一**能结算的来源 |
| **allowed negative evidence** | `explicit_denial` **仅此一种**。`exclusive_outcome` ✗ · `threshold` ✗ · `window_closure_negative` ✗（**禁止用行为或沉默反驳内心状态**） |
| **opportunity requirement** | REQUIRED（`utterance-slot` / `explicit-report-request` / `elapsed-window`） |
| **settlement threshold** | `matched` = 1 条 EXPLICIT_USER_REPORT，且必须**时间受限**（"在 T 时刻的状态"，不是持久特质）。行为 / 语言证据**永不**足够（SUPPORTING / CANDIDATE） |
| **是否允许自动结算** | **CONDITIONAL / 最保守**：`matched` 仅经 explicit report；`missed` 仅经 explicit denial；其余一律 `unresolvable` |
| **额外硬限制** | 预测**必须**带有限 observationWindow；`generalizationLevel` 只允许 `episode-hypothesis`；**第三方主体禁止**（`LATENT_STATE_THIRD_PARTY = FORBIDDEN`） |

**对"用户没继续聊 → 用户失望 → matched"这条链的机械否决**

```
① 来源层面：沉默 / 回复长度 / 延迟 / 话题未延续 只能以 BEHAVIORAL_TELEMETRY 出现，
   而该行在 §D.2 矩阵里**整行 FORBIDDEN**。
② 若把它包装成 CANONICAL_RUNTIME 的"未收到消息"事实：
   该事实可以谈 targetDomain='user_behavior'，但**不能**谈 'latent_state'
   （§D.3 domain-payload 一致性：主观域必须 outcomeRef.kind='statement' 且
    只能来自 EXPLICIT_USER_REPORT 或 LINGUISTIC_EVIDENCE）。
③ 即使某条 LINGUISTIC_EVIDENCE 声称"他失望了"：latent_state 的 ceiling 是 FORBIDDEN。
④ 结论：该链在第 ①/②/③ 步**任何一步**就被拒，而不是靠"权重低"。
```

### F.4 relational（关系预测）

| 维度 | 裁决 |
| --- | --- |
| **strongest authority** | `EXPLICIT_USER_REPORT`（用户对自己立场的陈述） |
| **allowed negative evidence** | `explicit_denial` **仅此一种**。`exclusive_outcome` ✗ · `threshold` ✗ · `window_closure_negative` ✗ |
| **opportunity requirement** | REQUIRED |
| **settlement threshold** | `matched` = 1 条 EXPLICIT_USER_REPORT；行为累积分支存在但 v1 **OFF** |
| **是否允许自动结算** | **NO**（v1 全禁自动结算）：除 explicit report / explicit denial 外一律 `unresolvable` |
| **额外硬限制** | 结算 **MUST NOT** 写 relationship store / trust / affinity / familiarity / persona。既有 `role-dm-core.js:505 relationDelta(observation)` 是**另一条**（会改状态的）路径，本轮**不接、不改、不竞争**（§0.9 C-vocab ④） |

```
RELATIONAL_AUTO_SETTLE = NONE
RELATIONSHIP_WRITE_FROM_SETTLEMENT = FORBIDDEN
```

### F.5 四类横向对照（本轮要的"不能套同一套标准"）

| | event | preference | latent_state | relational |
| --- | --- | --- | --- | --- |
| strongest authority | CANONICAL_RUNTIME / USER_BEHAVIOR | EXPLICIT_USER_REPORT | EXPLICIT_USER_REPORT（唯一） | EXPLICIT_USER_REPORT（唯一） |
| negative 允许的形状 | exclusive_outcome · explicit_denial · window_closure_negative · threshold | explicit_denial（missed）· exclusive_outcome（仅 mixed） | explicit_denial | explicit_denial |
| opportunity required | 负方向 YES | YES | YES | YES |
| matched threshold | 1 ELIGIBLE | 1 report **或** 3 不同机会行为 | 1 report（时间受限） | 1 report |
| auto settle | YES | CONDITIONAL（行为分支 v1 OFF） | CONDITIONAL（仅 explicit） | **NO** |
| 可否由"absence"结算 | 仅 window_closure_negative + full attestation | 否 | 否 | 否 |
| 单次行为能确认吗 | 可以（事件就是单次） | **不可以** | **不可以** | **不可以** |

### F.6 Prediction Error 的幅度（v1 只做 ordinal，不做数值）

```
CONFIDENCE_BUCKETS = low [0,0.34] · medium (0.34,0.66] · high (0.66,1] · unstated(null)

direction ∈ ['over-confident', 'under-confident', 'calibrated', 'unknown']
magnitude ∈ ['none', 'low', 'moderate', 'high', 'unknown']
```

**`direction` / `magnitude` 查表（唯一来源；模型不参与）**

| settlement \ confidence | low | medium | high | unstated |
| --- | --- | --- | --- | --- |
| `matched` | under-confident / **moderate** | calibrated / low | calibrated / none | unknown / unknown |
| `missed` | over-confident / low | over-confident / moderate | over-confident / **high** | unknown / unknown |
| `mixed` | unknown / unknown | unknown / **low** | unknown / **moderate** | unknown / unknown |
| `expired_unobserved` | unknown / unknown | unknown / unknown | unknown / **moderate** | unknown / unknown |
| `unresolvable` | unknown / unknown | unknown / unknown | unknown / unknown | unknown / unknown |
| `superseded` | unknown / unknown | unknown / unknown | unknown / unknown | unknown / unknown |

**四条冻结**

```
G-PE-1  magnitude = 'unknown' **MUST NOT** 被当成 'none' 参与任何聚合
G-PE-2  missed + confidence=unstated ⇒ magnitude 必须是 unknown（**不许**猜一个数）
G-PE-3  predictionErrorMetric = null（**保持** null；仓库规则：没有冻结公式就不得造数值
        —— metamemory-shadow.js:85-90 "凭审美造 0.73 就是把无知伪装成精度"）
G-PE-4  模型**不产出** direction / magnitude / metric（连 ordinal 都不给）
```

**未来如何扩展（明确写出来，避免以后重开 authority）**

```
v1   : counts + ordinal（本文件）
v2   : 需要 durable settled ledger（§34.2 的 sibling store 形状）
       ⇒ per-type reliability = matched/(matched+missed)（分类型，不混合）
v3   : 需要样本量与独立性 → Brier / ECE
       前置条件（全部必需）：
         · durable 结算账本（Home Node single writer，§34.1）
         · 独立观察原语（今天**不存在**，§0.9 C10）
         · 选择性偏差控制：只统计"有机会且被观察"的 prediction，并公开未观察比例
       禁用：把 calibration 结果回写成被结算 prediction 自身的 confidence（§32 / G-PE-5）
```

---

## G · Anti-Hallucination Guardrails（硬规则 · 每条必须可测）

> 形式：**规则** / **机械形式**（代码里长什么样）/ **测试形式**（怎么证明它没被绕过）。
> 规则编号 G1–G28 与 §F 的策略表互为表里：策略表说"允许什么"，本节说"不可能发生什么"。

### G.1 模型不得宣布结算（对应要求 #3）

| # | 规则 | 机械形式 | 测试形式 |
| --- | --- | --- | --- |
| **G1** | 模型输出词表**只有** 4 个关系值 | `RELATIONS = ['support','conflict','irrelevant','ambiguous']`；出集合 ⇒ **整条 match 丢弃**（不是截断） | 喂 12 个诱饵（`confirmed`/`contradicted`/`matched`/`missed`/`true`/`1`/`likely`/`probably`/`керек`…）⇒ 全部 `rejected` |
| **G2** | 模型输出里出现任何 settlement 状态词 ⇒ 丢整条 | 对 match 对象做**全字段**扫描，命中 `SETTLEMENT_STATES` ∪ `LEGACY_RESULTS` 任一 ⇒ `modelAttemptedSettlement` | 在 `rationale` / `strengthHint` / 自定义字段里塞 `"missed"` ⇒ 全拒 |
| **G3** | 模型**不得**产出任何 confidence / metric / direction / magnitude | 禁止键闭集：`confidence` `evidenceConfidence` `calibrationConfidence` `settlementConfidence` `predictionError` `predictionErrorMetric` `direction` `magnitude` `score` `probability` ⇒ 出现即丢 | 逐键注入 ⇒ 全拒（沿用既有 `modelWroteSystemField` 纪律） |
| **G4** | `validated` **不是**调用方可声明的布尔 | `validated` 只能由 Settlement Engine 的 module-private 能力（WeakSet/WeakMap）产生；裸对象写 `validated:true` 被拒 | 复刻 R4-D.2 的 forge 矩阵：复制 brand / 复制 `validated:true` / 改写已封存对象 ⇒ 三种全部被拒 |
| **G5** | 模型**不得**选择 predictionType / policy / window / opportunity / contamination | 这些字段在 match 的输入 schema 里**不存在**；出现即 `unknown-field` | 让"模型"尝试声明 `predictionType:'event'` ⇒ 请求即被拒 |

### G.2 absence 不得当 contradiction（对应要求 #5）

| # | 规则 | 机械形式 | 测试形式 |
| --- | --- | --- | --- |
| **G6** | **`missed` 必须四条件齐备** | `opportunity==='SATISFIED'` ∧ `admissibility==='ELIGIBLE'` ∧ `contradictionMode !== 'none'` ∧ 观察满足 mode | 逐个抽掉一个条件 ⇒ 状态**绝不**是 `missed`（四组负控制） |
| **G7** | 机会 `ABSENT` ⇒ **只能** `expired_unobserved` | 状态计算表 §E.4 第 5 行 | popup 未展示样本 ⇒ `expired_unobserved` ∧ reasonCode `opportunity-absent` |
| **G8** | 机会 `UNKNOWN` ⇒ **只能** `unresolvable` | §E.4 第 6 行 | 机会证据缺失 ⇒ `unresolvable` |
| **G9** | `window_closure_negative` 需**完整性证明**且**仅机制域** | `completeness==='full-window-attested'` ∧ `targetDomain ∈ {runtime_state,user_behavior}`，否则降 `unresolvable` | 伪造/缺失 attestation ⇒ 降级；主观域用该 mode ⇒ 建档即拒 |
| **G9b** | `expired_unobserved` 与 `unresolvable` **不得**在聚合里折叠成 `missed` | 聚合函数**不接受**把这两个状态映射到 `missed`；映射表是闭集 | 单元测试：聚合输入含这两种状态 ⇒ 输出 `missed` 计数恒 0 |

### G.3 单次行为不得升级成长时偏好（对应要求 #7）

| # | 规则 | 机械形式 | 测试形式 |
| --- | --- | --- | --- |
| **G10** | 行为证据对 preference/relationship 的**上限是 SUPPORTING** | §D.2 矩阵硬编码；矩阵是天花板 | 1 条 `USER_BEHAVIOR` 支持 ⇒ 状态绝非 `matched`（最多 `mixed`/`pending`） |
| **G11** | 行为累积需**不同机会实例**且**零冲突** | 门槛 = 3 且 `distinct(sourceInstance, observedAt, opportunityId)`；任一冲突 ⇒ 不是 `matched` | 3 条同一 `opportunityId` ⇒ 计数 1；3 条含 1 冲突 ⇒ 不结算 |
| **G12** | 行为累积分支 **v1 默认 OFF** | `AUTO_SETTLE_PREFERENCE_FROM_BEHAVIOR = OFF` ⇒ 仅累积 + 记 `gateTrace` | 开关 OFF 时：只有行为证据 ⇒ `unresolvable` ∧ `behavior-accumulation-only-insufficient` |
| **G12b** | 该计数**绝不**回写 L5 | 代码级断言：Registry/Settlement 源码**零处**出现 `independentObservationCount` | 静态扫描（stripJsComments）零命中；复用 §0.9 C10 的守卫 |

### G.4 latent-state 不得脑补（对应要求 #7）

| # | 规则 | 机械形式 | 测试形式 |
| --- | --- | --- | --- |
| **G13** | latent_state / relationship 的 ceiling：**只有** `EXPLICIT_USER_REPORT` 是 ELIGIBLE | §D.2 矩阵 | 模型判断 `support` + `USER_BEHAVIOR` + `latent_state` ⇒ `authority-forbidden` |
| **G14** | 行为/语言证据**永不**足够结算主观域 | 上限 `SUPPORTING`/`CANDIDATE` ⇒ 不可达门槛 | 21 条不同 `LINGUISTIC_EVIDENCE` ⇒ 仍非 `matched` |
| **G15** | 主观域的 `outcomeRef` **必须**是 `statement`，且只能来自 report/linguistic | §D.3 domain-payload 一致性 | `CANONICAL_RUNTIME` 对 `user_emotion` 发 `token:'low'` ⇒ `domain-payload-inconsistent` |
| **G16** | 弱信号**在词表层面就不存在** | `BEHAVIORAL_TELEMETRY` 整行 FORBIDDEN；回复长度 / 沉默 / 延迟 / 话题未延续 只能落该 source | 端到端：构造"用户没继续聊"的全部三种包装 ⇒ 每一层各自被拒（§F.3 的 ①/②/③） |
| **G16b** | 第三方 latent_state 禁止 | `subject.kind === 'third-party'` ∧ `latent_state` ⇒ 建档即拒 | 建档负控制 |

### G.5 禁止自我实现预测（对应要求 #8）

| # | 规则 | 机械形式 | 测试形式 |
| --- | --- | --- | --- |
| **G17** | `interventionContext` 是**必需**字段 | 缺失 ⇒ `contaminationClass='UNKNOWN'`（**不是** NONE） | 省略字段 ⇒ 主观域 `FORBIDDEN`、机制域降 `SUPPORTING` |
| **G18** | 污染闸门**区分事实与含义** | 机制域不降级（事件事实仍可结算）；主观域上限压到 SUPPORTING 且**禁止 `missed`** | popup+cancel：`event` 可 `missed`/`matched`；同一次观察用于 `preference` ⇒ 最多 `mixed` |
| **G19** | `behaviorEffectsApplied` **必须有唯一填点** | 填点 = Prediction Registry（§C.1 ⑨）；D.2 的同名槽位同步语义（§B.6）——**不得**出现两个 authority | 静态断言：除 Registry 外无第二处写入；§31 三字段在 settlement 记录里**全部在场** |
| **G20** | 自影响结算**不得**计独立确认 | `behaviorEffectsApplied.length > 0` ∨ `contaminationClass !== 'NONE'` ⇒ 该次结算 `calibrationCounted:false` + `calibration-excluded-contaminated` | 契约 §39 `:3090` 的机械形式：非空时计数不变 |

### G.6 Prediction Error 不得反向污染 Memory（对应要求 #10）

| # | 规则 | 机械形式 | 测试形式 |
| --- | --- | --- | --- |
| **G21** | Settlement/Error/Calibration **零** canonical 写路径 | 三个新文件**不得** require `memory-store` / `memory-authority`；不得出现 `dbPut` / `putRecord` / `rewrite` | 静态扫描 + **真实 store** 前后指纹比对（补上契约 §39 `:3089` 今天只做了一半的那条：§A.9 C9） |
| **G22** | Calibration 只影响两个目标 | 允许目标 = `ExpectationConfidence` / `InterpretationConfidence`；白名单**闭集**，其它一律 `calibration-target-forbidden` | 尝试写 memory / relationship / persona / Understanding / MemoryValue / recall score ⇒ 全部拒绝 |
| **G23** | **不得**更新被结算 prediction 自身的 confidence | calibration 只作用于**未来** expectation；`settlement.predictionId` 与目标 id 相同 ⇒ 拒绝 | 自反写入负控制；并**补上**契约 §39 `:3091` 承诺但今天缺失的"同一 prediction 反复 settlement 的 confidence 有界断言"（§A.9 / C10） |
| **G24** | Calibration **不得**写回 `subjectiveConfidence` | 契约 §32 `:2858-2859` 逐字：`MUST NOT 回写成 subjectiveConfidence`；v1 `CALIBRATION_APPLIED_TO_LIVE = NO` | 断言 `calibrationConfidence === null` 且无任何写回路径 |

### G.7 横向（fail-closed / 可审计 / 无伪造精度）

| # | 规则 | 机械形式 | 测试形式 |
| --- | --- | --- | --- |
| **G25** | 任一闸门输入缺失 ⇒ 该闸门取 `FORBIDDEN`（不是"跳过"） | `min()` 的每个因子在缺失时返回 `FORBIDDEN`；`min` 序：FORBIDDEN < CANDIDATE < SUPPORTING < ELIGIBLE | 逐字段抽掉 ⇒ 结果单调不升 |
| **G26** | 每次 settlement **必须**带 `gateTrace` + `reasonCodes` | 缺任一 ⇒ 该 settlement 视为无效（不落任何账本） | schema 校验负控制 |
| **G27** | **不得**造未冻结的数值 | `predictionErrorMetric = null`；`magnitude` 只能是 ordinal；`calibrationConfidence = null` | 静态 + 运行断言：任何 `0.xx` 形态的预测精度都不存在 |
| **G28** | 幂等：一个 prediction 至多结算一次 | `SETTLEMENT_ONCE`；重复 ⇒ `already-settled`，状态与账本不变 | 同一 prediction 结算 5 次 ⇒ 账本计数 +1（不是 +5） |

### G.8 本轮**不做**的守卫（诚实登记，避免误以为已闭合）

```
GAP-1  I21 的 disclosure gate（契约 §35.3 :2992 / I4·I21 :988,:1005）**仍无生产 caller**
       ⇒ v1 的 Prediction Error **不得**进入任何输出面（prompt / UI / 日志正文 / export）
          否则等于在未闭合的 disclosure 门上开一个新洞。
GAP-2  `prediction-error` 的 token 禁令**拼写不敏感度不足**
       （runtime-seam-guard.js:113-115 用 indexOf('prediction-error')，
        而 runtime-recall.js:1549 是 camelCase `predictionErrorLive` ⇒ 不命中）
       ⇒ 相位迁移时**必须**把匹配改为分隔符/大小写归一，并补对抗样本（§H.4 T-G1）。
GAP-3  FORBIDDEN_WIRING 当前是 **空列表**（test_reconstructive_memory_contract.js:74）
       ⇒ §37 :3055 的"production 面零引用"**今天是假命题**，N1 永不失败。
       本文件的落地**不得**依赖该守卫提供任何保证。
GAP-4  契约 §39 :3089/:3091 承诺的两条机械证明今天只有一半：
       canonical fingerprint 比对只对**测试自建对象**做（不是 store）；
       "同一 prediction 反复 settlement 的 confidence 有界断言"**不存在**。
```

---

## H · Recommendation：最小可行 Prediction Error v1

### H.0 一句话

> **v1 只立 authority，不做智能**：一个**进程内、有界、无模型调用、无持久写**的
> `Prediction Registry + Authority Gate + Settlement Engine + ordinal Error + 只读 Calibration Ledger`；
> 结算状态用七词表；`CALIBRATION_APPLIED_TO_LIVE = NO`；
> **不碰 Memory / Relationship / Recall 信封 / 输出面**。

优先序（本文件每条设计都服从它）：
`authority 清晰 > deterministic settlement > fail-closed > 可审计 > 可解释 > 可测试 ≫ 更聪明`

### H.1 范围（做什么 / 不做什么）

| 做（v1） | 不做（v1，且需要单独裁决才能做） |
| --- | --- |
| Prediction Registry（进程内 · 有界 · session-scoped） | durable prediction / observation 表（§34.2 要求 sibling store + Home Node single writer） |
| Outcome Observation（纯核心 + 授权注册表 + 4 闸门） | 任何模型调用（成本包线冻结 1+1+0=2，无第三个策略位） |
| Settlement Engine（7 状态 · 幂等 · gateTrace） | Evidence Matcher 的**启用**（代码就绪、默认 OFF） |
| Prediction Error（direction + ordinal magnitude） | `predictionErrorMetric` 数值 / Bayesian / Brier |
| Calibration Ledger（**只读**计数账本） | calibration 写回 live expectation / interpretation |
| 复用 D.2 的 capability seal 关掉 `judgement.validated` 洞 | `LEGACY_RESULT_ADAPTER`（`matched→confirmed` 之类） |
| 新增 addendum (q) 到冻结契约（**追加，不改写**） | 修改 `RECONSTRUCTIVE_MEMORY_CONTRACT.md` 的既有条款 |
| — | `independentObservationCount` 的任何写入 |
| — | recall 信封第 18 键 / `prediction*` 进入 recall 响应（17 键 + AE4 断言被冻结） |
| — | Prediction Error 进入 prompt / UI / 日志正文 / export（GAP-1） |

### H.2 落地形状（模块 · 进程位置 · 命名）

```
① assets/js/memory-recall/outcome-observation-core.js      纯核心（UMD · Node + Browser）
     buildOutcomeObservation()   ← 唯一合法 observation 来源（capability seal）
     isBuiltObservation()        ← 身份 + 封存逐字一致
     MATRIX / DOMAINS / SOURCES / CONTAMINATION_CLASSES
     authorityGate()             ← min() 只降不升
     ※ 零 I/O · 零网络 · 零模型 · 零时钟（now 由调用方注入）· 零持久化

② services/home-node/runtime-prediction-registry.js        进程内 registry
     mintPredictionId()          ← 确定性派生（无计数器 / 无随机 / 不读时钟）
     projectFromValidatedExpectation()  ← 确定性投影（不新增内容）
     recordOutcomeObservation()  ← 唯一的 behaviorEffectsApplied 填点
     bounded holder（沿用 64 条 / 10 分钟纪律）+ 显式 idLifetime 声明

③ services/home-node/runtime-prediction-settlement.js      确定性结算 + error + 只读账本
     settle()                    ← §E.2 T0–T8
     computePredictionError()    ← §F.6 查表
     calibrationLedger()         ← 只读 · counts only · 永不写回

④ tests/
     test_outcome_observation_authority.js   （矩阵 + 4 闸门 + capability forge 矩阵）
     test_prediction_settlement_core.js      （7 状态 + 幂等 + error 表 + 反脑补）
     test_prediction_settlement_guards.js    （静态守卫迁移 + GAP-2 对抗样本）
     test_r4pe_live_settlement.js            （端到端：Node 装配 + 假 provider = 0 次调用）

⑤ docs/contracts/memory/RECONSTRUCTIVE_MEMORY_CONTRACT.md  ← **只追加** addendum (q)
   docs/contracts/memory/PREDICTION_ERROR_AUTHORITY_CONTRACT.md（本文件）
```

**三条结构性决定**

```
D1  Registry / Observation / Settlement **全部在 Home Node 同一进程、同一模块实例**。
    理由：§0.9 C13 —— D.2 的能力原语是 module-private WeakSet/WeakMap，
    **跨实例即失效**；因此 observation **只在 Node 侧构建**，
    且**绝不**接受来自另一个模块实例 / 另一个进程 / 浏览器的 observation。

D2  Registry 通过**内部 seam** 从 runtime-expectation.js 的 held 接出
    （不经路由、不进响应、不新增内容 API）。
    理由：§0.9 C14 —— live expectation 内容结构性不可读，而 settle 需要
    predictionSnapshot + expectationId。这是一次**需要显式论证的窄改动**，
    必须保留 `contentExposed:'NO'` / `browserVisible:'NO'` 对**外部**仍然成立。

D3  Registry **不**搭 recall 信封（§0.9 C16）：17 键形状与
    "recall JSON 不含 expectation/prediction 子串"的断言都不动；
    结算面是**独立的内部边界**。
```

**id 生命周期必须显式声明**（契约 (k-7) `:1886-1889`：runtime-only 期望
`**不生成"看似永久、reload 后失效"的 id**`）：

```
predictionId           = 'pred_' + stableToken(characterId|conversationId|turnId|expectationIndex|predicateFingerprint)
idLifetime             = 'SESSION_ONLY'          // 显式，绝不假装 durable
lifetimeDeclaration    = REQUIRED 字段（写入 PredictionRecord 与 SettlementRecord）
crossRestartExactlyOnce = 'NO'                    // 与既有 holder 同一诚实口径
```

**命名约束**：`FORBIDDEN_STORES = ['expectation','expectations','counterfactual','counterfactuals','metamemory']`
仍在守卫里 ⇒ 新模块**不得**以这些名字创建 store；本设计用 `prediction-registry` / `outcome-observation`。

### H.3 交付顺序（P0 已收口；每阶段可独立验收）

```
P0    Contract Reconciliation                          ← **本轮已完成**
      · 六项 owner ruling 登记（§I.1）
      · 三处内部冲突收口（§I.2）
      · addendum (q) 追加到 RECONSTRUCTIVE_MEMORY_CONTRACT.md（§I.3）
      · GAP registry 登记（§I.6）

P1    OutcomeObservation Core
      + Authority Matrix + gates + capability seal      （**无 production wiring**）

P1.5  Runtime Seam Guard phase migration                ← **顺序被 R3 提前**
      + separator / case normalization
      + adversarial fixtures（含 camelCase 绕过）

P2    Prediction Registry
      + session-only holder
      + Expectation structured projection（TYPE_TABLE / §C.4）
      + D.2 capability transfer（R4：关掉 caller self-validation）

P3    Settlement Engine
      + seven-state machine（§E.4 有序判定）
      + ordinal Prediction Error
      + internal audit only（R6）

P4    Calibration Ledger
      + counts only
      + CALIBRATION_APPLIED_TO_LIVE = NO

P5    **separate future ruling**（本轮不授权）：
      durable ledger · Evidence Matcher enablement · calibration writeback · external disclosure
```

**硬规则（R3 冻结）**

```
PURE CORE MAY BE WRITTEN FIRST.
NO LIVE SETTLEMENT WIRING BEFORE P1.5 GUARD PASSES.
```

即：P1 的纯核心可以先写（它没有任何 production seam），
但**任何** production Prediction Error seam 出现之前，P1.5 的守卫相位迁移必须已经完成并通过对抗样本。
原因：当前 `indexOf('prediction-error')` 连 camelCase 都抓不住（§0.9 C24 / GAP-2），
在这样一个"名义守卫"之下加 seam，等于把新通道建在一个已知漏检的闸门上。

### H.4 必测清单（v1 的最小证据集）

| 编号 | 断言 | 对上哪条要求 |
| --- | --- | --- |
| T-A1 | observation 由 builder 产出才可 settle；复制 brand / 复制 `validated:true` / 改写封存对象 三种伪造全部被拒 | #3 |
| T-A2 | 矩阵是天花板：逐字段抽掉任一闸门输入 ⇒ admissibility **单调不升** | #2 |
| T-A3 | `MODEL_INFERENCE` 与 `BEHAVIORAL_TELEMETRY` 对**所有** domain 恒 `FORBIDDEN` | #2 · #7 |
| T-S1 | `missed` 的四条件负控制（逐个抽掉 ⇒ 绝不 `missed`） | #5 · #6 |
| T-S2 | popup 三态：未展示 ⇒ `expired_unobserved`；展示未选择 ⇒ `expired_unobserved`；展示且互斥选择 ⇒ `missed` | #5 |
| T-S3 | 机会 `SATISFIED` + 窗口关闭 + 零可采证据 ⇒ `unresolvable`（**不是** `expired_unobserved`） | #5 |
| T-S4 | 7 状态机：每个终态不可再转移；重复结算 5 次 ⇒ 账本 +1 | #4 |
| T-P1 | preference：1 条行为 ⇒ 绝非 `matched`；3 条同一 opportunity ⇒ 计数 1；含冲突 ⇒ 不结算；开关 OFF ⇒ `unresolvable` | #7 |
| T-P2 | latent_state：21 条语言证据 ⇒ 仍非 `matched`；第三方主体 ⇒ 建档即拒 | #7 |
| T-P3 | relational：除 explicit report/denial 外恒不结算，且零 relationship 写入 | #7 · #10 |
| T-E1 | error 表逐格比对（9 组）；`unstated` ⇒ `magnitude==='unknown'`；`unknown` **不**计入 `none` | #9 |
| T-E2 | `predictionErrorMetric === null` ∧ `calibrationConfidence === null` ∧ 无任何写回路径 | #9 · #10 |
| T-I1 | `interventionContext` 缺失 ⇒ 主观域 FORBIDDEN；popup+cancel 对 event 可结算、对 preference 最多 `mixed` | #8 |
| T-I2 | `behaviorEffectsApplied` 非空 ⇒ `calibrationCounted:false`（契约 §39 :3090） | #8 |
| T-M1 | **真实 store** 前后指纹逐字节相等（补上 §A.9 C9 那一半） | #10 |
| T-M2 | 静态：三个新文件零 `dbPut`/`putRecord`/`rewrite`/`memory-store` 引用 | #10 |
| T-G1 | **GAP-2**：把 `predictionErrorLife` 之类 camelCase 变体放进 recall 边界 ⇒ 守卫**必须**抓住（今天抓不住） | #3 · 治理 |
| T-G2 | 对抗样本：第二 seam / 在 selector 阶段结算 / 源回合直接消费 / 从浏览器提交 observation ⇒ 全被抓 | 治理 |
| T-X1 | recall 响应仍是 17 键且不含 `expectation`/`prediction` 子串（AE4 不回归） | 治理 |

**零真实出网**：全部用注入假 provider（`*.invalid`），并断言 `PROVIDER_CALLS = 0`（v1 无模型调用）。

### H.5 六项 owner ruling —— **P0 已批准，不再是开放问题**

> 本节已由 P0 从"待裁决"转为"已冻结"。最终值与正文位置见 **§I.1**。

| # | 议题 | 最终裁决（P0） |
| --- | --- | --- |
| R1 | Registry 生命周期 | `PREDICTION_REGISTRY_LIFETIME = SESSION_ONLY` · `DURABLE_PREDICTION_STORE = NO_V1` · `CROSS_RESTART_EXACTLY_ONCE = NO` · `RESTART_RECOVERY = NONE` · `idLifetime` 必须显式 |
| R2 | Expectation additive schema extension | **批准**；`subject/predicate/expectedOutcome` 只受闭集校验；无结构 ⇒ `settleable=false`；**并裁决** `MODEL_MAY_NOT_CHOOSE_PREDICTION_TYPE = YES` |
| R3 | Runtime Seam Guard 相位迁移 | **批准**，并把顺序**提前到 production wiring 之前**（P1.5）；匹配须 separator/case-aware + 对抗样本 |
| R4 | D.2 `judgement.validated` 能力转移 | **现在关掉**：`CALLER_SUPPLIED_VALIDATED = INVALID` |
| R5 | `AUTO_SETTLE_PREFERENCE_FROM_BEHAVIOR` | **OFF**，且 v1 **不**作为 operator 可打开的功能 |
| R6 | 结算面可见性 | `SETTLEMENT_DISCLOSURE_V1 = INTERNAL_AUDIT_ONLY` |

### H.6 明确不推荐的事（"更聪明但牺牲 authority"的清单）

```
✗ 用模型输出直接决定 matched / missed
✗ 把沉默 / 回复长度 / 延迟 当作心理状态证据（"用户没继续聊 → 失望"）
✗ 单次行为升级成长时偏好
✗ 用一个 0..1 的"预测准确率"数字替代七状态
✗ 让 Prediction Error 直接改写 Memory / Understanding / relationship
✗ 把 calibration 结果写回被结算 prediction 自身的 confidence
✗ 为了"更强"给 Evidence Matcher 开第三次模型调用（成本包线是冻结的）
✗ 改 RECONSTRUCTIVE_MEMORY_CONTRACT.md 的既有条款（应追加 addendum）
✗ 依赖当前那条**空**的 FORBIDDEN_WIRING 提供任何保证
✗ 把 Prediction Error 暴露到 prompt / UI（在 disclosure gate 闭合之前）
```

### H.7 本轮的诚实边界（P0 之后）

```
P0_THIS_ROUND = CONTRACT RECONCILIATION（收口，不实现）
P0_IMPLEMENTATION          = NONE
P0_PRODUCTION_WIRING       = NONE
P0_MODEL_CALLS_ADDED       = 0
P0_DURABLE_WRITES_ADDED    = 0
P0_RECALL_ENVELOPE_CHANGED = NO
P0_UI_DISCLOSURE_CHANGED   = NO
COMMITS                    = NONE
PUSH                       = NONE
WORKTREE_UNRELATED_CHANGES = UNTOUCHED

VERIFIED_BY_EXECUTION（P0 实际复跑）：
  · tests/test_reconstructive_memory_contract.js → PASSED · 87 assertions green
  · tests/test_expectation_shadow.js             → PASSED · 95 assertions green
  · runtime-seam-guard.js:113-115 的 camelCase bypass 已由主笔直接读码确认
    （`code.toLowerCase().indexOf('prediction-error')`；`predictionError` 归一后
     为 `predictionerror`，**不含连字符** ⇒ 不命中）

STILL_UNVERIFIED（诚实登记）：
  · 新设计的任何 runtime 行为（因为尚未实现）
  · §A.9 / §0.9 C7–C27 中**未被主笔直接复核**的行号（来自并发审计报告）
```

> 上一轮（设计轮）的边界声明保留在 §I 之外的历史记录中：
> 当时报告"未独立复跑既有套件"；**P0 已补上**这两条守卫的实跑（见上）。

---

## I · P0 · Contract Reconciliation（本轮收口 · 已完成）

> 本轮目标只有一个：把 owner rulings、authority supersession 与已发现的契约内部歧义
> **正式收口**，使 Prediction Error 成为可进入 P1 的 canonical contract。
> `IMPLEMENTATION = NONE` 不变。

### I.1 六项 Owner Ruling（正式冻结值）

```
R1  PREDICTION_REGISTRY_LIFETIME   = SESSION_ONLY
    DURABLE_PREDICTION_STORE       = NO_V1
    CROSS_RESTART_EXACTLY_ONCE     = NO
    RESTART_RECOVERY               = NONE
    PREDICTION_ID_LIFETIME_DECLARED = REQUIRED（idLifetime: 'SESSION_ONLY'）
    REGISTRY_SESSION_REF            = REQUIRED（审计归属，不引入持久化）

R2  EXPECTATION_ADDITIVE_SCHEMA_EXTENSION = APPROVED
    REQUIRED_STRUCTURED_FIELDS            = subject.kind · predicate.kind · expectedOutcome.kind
    UNSTRUCTURED_EXPECTATION_SETTLEABLE   = NO
    FREE_TEXT_TO_PREDICTION_PARSING       = FORBIDDEN（无 NLP / 无隐式解析 / 无额外模型调用）
    MODEL_MAY_NOT_CHOOSE_PREDICTION_TYPE  = YES
    PREDICTION_TYPE_AUTHORITY             = DETERMINISTIC_DERIVATION_FROM_STRUCTURE
    TYPE_TABLE_AMBIGUOUS                  ⇒ settleable=false · 'prediction-type-ambiguous'
    RELATIONAL_DISAMBIGUATION             = PREDICATE_KINDS 增补
                                            'relationship-state' / 'relationship-change'

R3  RUNTIME_SEAM_GUARD_PHASE_MIGRATION = APPROVED
    GUARD_MIGRATION_ORDER              = BEFORE_ANY_PRODUCTION_PE_SEAM（P1.5）
    GUARD_MATCH_MODE                   = SEPARATOR_AND_CASE_AWARE
    GUARD_ADVERSARIAL_FIXTURES        = REQUIRED
    GUARD_RELAXATION                   = NO（这是修 bypass，不是放宽）

R4  CALLER_SUPPLIED_VALIDATED         = INVALID
    VALIDATION_SOURCE                  = SETTLEMENT_ENGINE_MODULE_PRIVATE_CAPABILITY
    R4D2_DISPOSITION                   = KEEP · NOT_DELETED · DEMOTED_TO_PROTOCOL_PRIMITIVE
    R4D2_RETAINS                       = snapshot integrity · linkage
    SETTLEMENT_STATE_AUTHORITY         = DETERMINISTIC_POLICY_ENGINE（唯一）

R5  AUTO_SETTLE_PREFERENCE_FROM_BEHAVIOR = OFF
    OPERATOR_TOGGLEABLE                    = NO（v1 不是普通 operator 功能）
    BEHAVIORAL_SUPPORT_RECORDED            = YES（进 gateTrace · 可累计 supporting count）
    BEHAVIORAL_SUPPORT_AUTO_MATCH          = NO
    WRITE_INDEPENDENT_OBSERVATION_COUNT    = FORBIDDEN
    EXPLICIT_USER_REPORT_SETTLEMENT        = ALLOWED（按 policy）

R6  SETTLEMENT_DISCLOSURE_V1           = INTERNAL_AUDIT_ONLY
    ALLOWED   = Home Node internal structured audit · tests · internal inspection
    FORBIDDEN = Chat UI · Memory World · prompt · role-facing context ·
                recall envelope · normal log body · export
    UNTIL     = 独立 disclosure authority / I21 gate 真正闭合
```

### I.2 内部冲突收口证明（三处）

**C-1 · `predictionType` authority 不再矛盾** ✔

| | 修改前 | 修改后 |
| --- | --- | --- |
| §B.2 | `MODEL_MAY_NOT choose predictionType` | 保留并**形式化**为 `MODEL_MAY_NOT_CHOOSE_PREDICTION_TYPE = YES` |
| §C.1 字段表 | `predictionType event\|preference\|... REQUIRED`（读起来像模型填） | `← TYPE_TABLE[...] DERIVED system` |
| §C.3 表格 | "**只能从 4 值闭集里选**" | "**否**（R2 裁决）⇒ 模型提供即 `unknown-field`" |
| §F.0 标题 | "模型只能选类型，不能选策略" | "**模型不选类型，也不选策略**" |
| §C.4 | （不存在） | 新增 `TYPE_TABLE` 四步推导 + `INV-T1/T2/T3` |
| §B.2 禁止块 | 一行 | 增加 `MODEL_MAY_NOT choose contradictionMode` 与 R2 形式化块 |

**结论**：全文**唯一**的 `predictionType` 权威是 §C.4 的 `TYPE_TABLE`；
模型只提供三个受闭集校验的语义键。**INV-T3** 额外证明"选类型套利"已被关闭
（`prefers` 只映射到 `preference`，无法用 `event` 换取更低门槛）。

**C-2 · `expired_unobserved` 定义与 NOT-CONSUMED 一致** ✔

| | 修改前 | 修改后 |
| --- | --- | --- |
| §E.0 数组注释 | "窗口关闭，但**机会从未存在或从未被消费**" | "窗口关闭，且**没有形成一个可用于结果结算的 completed opportunity**" |
| §E.0 E-D | "expired_unobserved = 这件事**根本没机会发生**"（与 NOT-CONSUMED 分支矛盾） | "…判据是**机会是否完成**，不是结果"；`ABSENT` **与** `NOT-CONSUMED` 同属"未形成 completed opportunity" |
| §E.3 | `ABSENT` / `NOT-CONSUMED` 两个状态 | 保留（定义不变） |
| §E.4 行 5 | 与旧 E-D 措辞混用 | 明确 `ABSENT / NOT-CONSUMED ⇒ expired_unobserved` |
| reason codes | `opportunity-absent` / `opportunity-not-consumed` | **两者都保留**，作为 `expired_unobserved` 的两个 reason |

**结论**：`expired_unobserved` 现在只有一个定义（"window 关闭 ∧ 无 completed opportunity"），
`ABSENT` 与 `NOT-CONSUMED` 是它的两个 **reasonCode**，不是两种状态。
`SETTLEMENT_STATES` 仍是 **7** 个（未增加第八种）。`absence != missed` 保持。

**C-3 · T8 对所有合法 evidence 组合都有唯一状态** ✔

| | 修改前 | 修改后 |
| --- | --- | --- |
| §E.4 形式 | 无序条件表（8 行并列） | **有序判定表**（5 行，先命中先返回） |
| `mixed` | "双向都有可采证据且**都未达门槛**" | "双向证据**同时存在**且没有形成允许的 decisive settlement" |
| 缺格 | `matchedThresholdMet ∧ conflictAll > 0` ⇒ **无输出** | **行 3 命中 = mixed** |
| 闭合性 | 靠散文"注意最后两行" | **穷举证明**：行 3/4/5 互斥且穷尽 `(supportAll>0, conflictAll>0)` 四取值 ⇒ `E.4-TOTALITY` |
| 测试设计 | 无 | `T8-1`–`T8-6`，含 320 组 table-driven totality |

**结论**：`E.4-TOTALITY` 成立 —— 对任意合法输入组合，有且只有一个确定输出。
缺格样本（用户明确说喜欢 A = ELIGIBLE support；某次行为选择 B = SUPPORTING conflict）
现在稳定落到 **mixed**。

### I.3 Addendum (q) —— 最终正文位置

追加位置：**`docs/contracts/memory/RECONSTRUCTIVE_MEMORY_CONTRACT.md` 文件末尾**
（第 3112 行之后），标题 `## 附录 (q) · Prediction Error Contract Reconciliation（追加，不改写任何既有条款）`。

| 条目 | 内容 | addendum 内小节 |
| --- | --- | --- |
| q-1 | §28.2 authority supersession（`DECIDES → ADVISES` + `DIRECTION_OF_CHANGE = NARROWING`） | `(q-1)` |
| q-2 | 七状态 canonical vocabulary + `matched != canonical truth` / `missed != memory contradiction` / `LEGACY_RESULT_ADAPTER = NONE` | `(q-2)` |
| q-3 | `P26_2_OBSERVATION != OUTCOME_OBSERVATION` 命名边界 | `(q-3)` |
| q-4 | `AUTHORITY = source × targetDomain` + `effectiveAdmissibility = min(...)` + 只降不升 + `missing input => FORBIDDEN` | `(q-4)` |
| q-5 | 四类 prediction policy + `MODEL_MAY_NOT_CHOOSE_PREDICTION_TYPE` | `(q-5)` |
| q-6 | `calibrationEvidence` vs `calibrationConfidence` 命名归一（裁决：**同一量的历史命名漂移**，canonical 名 = `calibrationConfidence`） | `(q-6)` |
| q-7 | `OUTCOME_OBSERVATION_MUST_POSTDATE_PREDICTION = YES` | `(q-7)` |
| q-8 | GAP registry（GAP-1..GAP-4，含 status / owner phase / must-fix-before） | `(q-8)` |

### I.4 Supersession 声明（旧 §28.2）

```
§28.2                              = NOT DELETED · HISTORY PRESERVED
§28.2 的 "模型负责 confirmed/contradicted/partial" = SUPERSEDED BY addendum (q-1)
DIRECTION_OF_CHANGE                = NARROWING（收窄模型 authority）
CONTRACT_COMPATIBILITY             = 收窄安全；放宽才需要重新论证
MODEL_ROLE_CHANGE                  = DECIDES → ADVISES
SETTLEMENT_STATE_AUTHORITY         = DETERMINISTIC_POLICY_ENGINE（唯一）
```

**不就地改写**：`RECONSTRUCTIVE_MEMORY_CONTRACT.md` 的既有条款（含 §28.2 原文）
**逐字节保留**；收窄只发生在 addendum (q-1) 中并显式标注 supersession。
（house style：每个相位都是"追加，不改写"。）

### I.5 Guard phase order（确认已提前）

```
PURE_CORE_MAY_BE_WRITTEN_FIRST            = YES   （P1：无 production seam）
GUARD_MIGRATION_PHASE                     = P1.5
NO_LIVE_SETTLEMENT_WIRING_BEFORE_P1.5     = YES   ★ 硬规则
```

`GUARD_MIGRATION_BEFORE_SETTLEMENT_LIVE_WIRING = YES`
（修改前它在 P4 —— 即**晚于** Settlement live wiring，已被 R3 提前。）

### I.6 GAP registry（每条带 status / owner phase / must-fix-before）

| GAP | 描述 | status | owner phase | must-fix-before |
| --- | --- | --- | --- | --- |
| GAP-1 | disclosure gate（契约 §35.3 / I4·I21）**无 production caller** | OPEN · PRE-EXISTING | 未分配（需独立 disclosure 相位） | 任何 **external** settlement disclosure（P5） |
| GAP-2 | `runtime-seam-guard.js:113-115` 用 `indexOf('prediction-error')` ⇒ camelCase bypass | OPEN · CONFIRMED | **P1.5** | 任何 production Prediction Error seam |
| GAP-3 | `FORBIDDEN_WIRING = []`（`test_reconstructive_memory_contract.js:74`）⇒ 守卫空转；§37 的"零引用"为假 | OPEN · CONFIRMED | P1.5（与守卫迁移同批，或独立契约卫生相位） | 任何依赖该守卫提供保证的设计 |
| GAP-4 | 机械证明覆盖不完整：契约 §39 `:3089` 的 canonical fingerprint 只对**测试自建对象**做；`:3091` 的"反复 settlement confidence 有界"断言**不存在** | OPEN · CONFIRMED | P3（Settlement）/ P4（Calibration） | P3 验收（canonical 逐字节）· P4 验收（有界性） |

```
GAP-1 与 R6 直接耦合：在 GAP-1 闭合之前，SETTLEMENT_DISCLOSURE_V1 必须保持 INTERNAL_AUDIT_ONLY。
GAP-2 与 R3 直接耦合：P1.5 完成前不得出现任何 production seam。
GAP-3 不阻塞 P1（纯核心），但阻塞任何"因为守卫是绿的所以安全"的推理。
GAP-4 不阻塞 P1/P2，但阻塞 P3/P4 的验收声明。
```

### I.7 Scope proof（本轮）

```
PRODUCTION_IMPLEMENTATION = NONE
PRODUCTION_WIRING         = NONE
MODEL_CALLS_ADDED         = 0
DURABLE_WRITES_ADDED      = 0
RECALL_ENVELOPE_CHANGED   = NO
UI_DISCLOSURE_CHANGED     = NO
COMMITS                   = NONE
PUSH                      = NONE

本轮写入面（documentation only）：
  MODIFIED  docs/contracts/memory/PREDICTION_ERROR_AUTHORITY_CONTRACT.md
  APPENDED  docs/contracts/memory/RECONSTRUCTIVE_MEMORY_CONTRACT.md（仅末尾追加 addendum (q)）
  NEW       （无生产代码 / 无测试 / 无 fixture）

禁止项自查：
  未写 Prediction Registry · 未写 OutcomeObservation runtime · 未写 Settlement Engine
  未接生产 seam · 未增加模型调用 · 未增加 durable store · 未改 recall envelope
  未暴露 UI / prompt / export
```

**本轮验证方式**：`docs/contracts/memory/` 的静态契约测试（见 §I.8）。

### I.8 本轮实际执行的验证

```
RUN  tests/test_reconstructive_memory_contract.js   → PASSED · 87 assertions green
RUN  tests/test_expectation_shadow.js               → PASSED · 95 assertions green
```

理由：这两条是**唯一**强制本契约的静态守卫（契约 §37）。
追加 addendum 与编辑设计文档都必须证明**没有让它们变红** —— 这是 P0 的验收面。

同时**复核**了 §0.9 C24 / GAP-2 的机制（本轮亲自读码，不是引用报告）：

```
tests/helpers/runtime-seam-guard.js:113-115   code.toLowerCase().indexOf(token)
                                              token = 'prediction-error'
services/home-node/runtime-recall.js:1549     predictionErrorLive: 'NO'   ← camelCase，不命中
⇒ 同一文件同时被 test_r4f_live_behavior_effect.js 断言 audit.ok === true
⇒ 确认：该禁令对 camelCase 形式**名义存在、实际失效**
```

### I.9 出口状态

```
P0_STATUS                  = COMPLETE
P1_STATUS                  = COMPLETE
NEXT_ALLOWED_PHASE         = P1.5（Runtime Seam Guard phase migration）
BLOCKED_UNTIL_P1.5         = 任何 production Prediction Error seam
STOP_AFTER_P0              = YES（P0 轮未进入 P1 —— 历史记录）
STOP_AFTER_P1              = YES（P1 轮未进入 P1.5 —— 但**不许**忘记 P1.5 是前置）
```

### I.10 P1 出口状态（OutcomeObservation Authority Core · 已实现）

```
新文件
  assets/js/memory-recall/outcome-observation-core.js      纯核心（UMD · 无 I/O · 无时钟 · 无模型 · 无 durable）
  tests/test_outcome_observation_authority.js             84 assertions green

接线
  PRODUCTION_WIRING        = NONE（生产面引用 = 0 · 未进 InternalBeyond.html · recall 信封未触碰）
  SETTLEMENT_ENGINE        = NONE
  PREDICTION_REGISTRY_LIVE = NO
  EVIDENCE_MATCHER_INVOCATION = OFF
  MODEL_CALLS_ADDED        = 0
  DURABLE_WRITES_ADDED     = 0

能力
  ONLY_BUILDER_MINTS_VALID_OUTCOME_OBSERVATION = YES（module-private WeakSet + WeakMap + deepFreeze）
  AUTHORITY                = source × targetDomain（42 格 ceiling · 无全局 rank）
  NO_GATE_MAY_RAISE_AUTHORITY = YES（六闸门 4^6 全枚举等于真正最小值；空列表 ⇒ FORBIDDEN）
  OPPORTUNITY_GATE         = DIRECTIONAL（标量不降；ABSENT/NOT-CONSUMED/UNKNOWN ⇒ negation 被禁）
  INTERVENTION_CONTAMINATION_INVALIDATES = 从行为到人的推论，不是行为事实
  OUTCOME_OBSERVATION_MUST_POSTDATE_PREDICTION = YES（已强制）
```

**P1 期间发现并就地冻结的一处语义漏洞（诚实登记）**

```
contaminationClass 是契约 §D.1 的 REQUIRED 字段。
若允许省略后被**静默**当成 NONE，则"没检查"会伪装成"没有污染"（fail-open）。
⇒ 已在核心中改为：省略 ⇒ 构建即拒（missing-required-field:contaminationClass）。
```

**P1 未做的事（P1.5 之前仍然是硬边界）**

```
P1.5 = Runtime Seam Guard phase migration（separator/case normalization + adversarial fixtures）
在 P1.5 通过前：ANY PRODUCTION PREDICTION ERROR SEAM = BLOCKED
```

### I.11 P1.5 出口状态（Runtime Seam Guard Migration · 已完成）

```
P1_5_STATUS                = COMPLETE
PHASE_TYPE                 = GOVERNANCE_MIGRATION（不是功能实现）
PRODUCTION_PE_WIRING       = NONE
PREDICTION_REGISTRY_LIVE   = NO
SETTLEMENT_ENGINE          = NONE
OUTCOME_OBSERVER_PRODUCERS_LIVE = NO
MODEL_CALLS_ADDED          = 0
DURABLE_WRITES_ADDED       = 0
RECALL_ENVELOPE_CHANGED    = NO
UI_DISCLOSURE_CHANGED      = NO
```

**关闭的两个真实 bypass**

```
① 拼写绕过
   旧：code.toLowerCase().indexOf('prediction-error') ⇒ camelCase 不命中
   新：normalizeSemantic() ⇒ prediction-error ≡ predictionError ≡ PREDICTION_ERROR
       ≡ prediction_error ≡ prediction.error ≡ prediction/error ≡ prediction error
② token 大小写空转
   旧：只 lowercase haystack、不 lowercase token
       ⇒ FORBIDDEN_IN_INTERPRETATION 里的 'behaviorEffect' **永远匹配不到**
   新：同一套 normalization 同时归一 haystack 与 token
```

**冻结的语义（已追加到契约 addendum）**

```
(q-10) OPPORTUNITY_GATE_IS_DIRECTIONAL = YES
       baseAdmissibility = min(matrixCeiling, scopeGate, temporalGate,
                               contaminationGate, domainPayloadGate)
       directionalAdmissibility.support  = baseAdmissibility
       directionalAdmissibility.conflict = min(baseAdmissibility, opportunityConflictGate)
       absence != missed · 机会不压制自发的正向证据

(q-11) Prediction Error seam taxonomy
       A DEFINITION_ALLOWED · B WIRING_FORBIDDEN · C FUTURE_RESERVED_SEAMS
       MUST 用 semantic normalization 匹配 banned list
       MUST NOT 仅凭"字符串出现"判定 production wiring
       只读自述（predictionErrorLive 等）具名闭集 + 每名至多一次 + 右侧必须字面量

(q-12) capability 装配约束
       SAME_MODULE_INSTANCE_REQUIRED = YES
       BROWSER_OUTCOME_OBSERVATION_ACCEPTANCE = FORBIDDEN
       JSON_TRANSPORT_RECONSTITUTION = FORBIDDEN
```

**审计结论（normalized matcher，全部审计面）**

```
PE capability tokens on any audited surface = 0
PE sites（全部为 LEGITIMATE_METADATA 只读自述）
  runtime-recall.js:1549            predictionErrorLive: 'NO'
  runtime-expectation.js:512        predictionErrorLive: 'NO'
  runtime-expectation.js:513        predictionErrorBlocker: 'LATER_OBSERVATION_AUTHORITY_NOT_CLOSED'
  runtime-behavior-effect.js:450    predictionErrorLive: 'NO'
  runtime-behavior-effect.js:451    predictionErrorCalls: 0
FORBIDDEN_WIRING found              = 0（没有任何 PE 接线被藏进 guard 盲区）
STALE_SELF_DESCRIPTION found        = 0（blocker 仍然成立：LIVE_CANONICAL_SOURCE_BINDING 仍 NOT_IMPLEMENTED）
```

**残留覆盖缺口（诚实登记，建议 P2 处理）**

```
GUARD_ENFORCEMENT_SCOPE_NOW = runtime-recall.js + runtime-interpretation.js + browser 边界
NOT_YET_ENFORCED            = runtime-expectation.js · runtime-behavior-effect.js
  它们当前只有 allowlisted 只读自述（上表 4 条），但**尚未**被 seam audit 强制。
  扩展 enforcement 到这两个文件属于 P2（它们会被 P2/P3 合法改动），
  届时需要把各自的声明 join 进 allowlist 并补对抗样本。
```

**下一相位门**

```
NEXT_ALLOWED_PHASE = P2
P2 = Prediction Registry
   + session-only holder
   + additive structured Expectation projection
   + stable prediction identity
   + D.2 judgement.validated capability transfer
本轮**未**进入 P2。
```

### I.12 P2 出口状态（Prediction Registry · 已完成）

```
P2_STATUS                    = COMPLETE
PREDICTION_REGISTRY_LIVE     = YES
REGISTRY_LIFETIME            = SESSION_ONLY
HOLDER                       = 64 条 / 600 000 ms / character+conversation+turn / 进程内存
SETTLEMENT_ENGINE            = NONE
LIVE_SETTLEMENT              = NO
MATCHED_MISSED_CALCULATION   = NONE
PREDICTION_ERROR_CALCULATION = NONE
CALIBRATION_APPLIED_TO_LIVE  = NO
EVIDENCE_MATCHER             = OFF
MODEL_CALLS_ADDED            = 0
DURABLE_WRITES_ADDED         = 0
RECALL_ENVELOPE_CHANGED      = NO
UI_DISCLOSURE_CHANGED        = NO
```

**新增文件**

```
assets/js/memory-recall/prediction-record-core.js      纯投影核心（TYPE_TABLE / projection / snapshot）
services/home-node/runtime-prediction-registry.js      会话内有界持有者
tests/test_prediction_registry.js                      61 条断言
```

**修改文件（P2 范围内）**

```
services/home-node/runtime-expectation.js   **唯一**批准的 PE 内部 seam（dep + 探针 + 锚后唯一调用）
services/home-node-service.js               装配构造 + 导出 runtimePredictionRegistry
assets/js/memory-recall/prediction-observation-core.js  D.2 capability transfer
tests/test_expectation_shadow.js            18 处调用点迁移到 capability + 9 条闭合断言
tests/helpers/runtime-seam-guard.js         P2.0 enforcement 扩展（expectation / behavior-effect）
tests/test_prediction_error_seam_guard.js   新增 H 段（P2.0 entry gate，49 条）
tests/test-all.js                           注册 P2 suite
docs/contracts/memory/RECONSTRUCTIVE_MEMORY_CONTRACT.md  addendum (q-13)
```

**P2.0 entry gate（先扩守卫，后写 seam）**

```
NO_REGISTRY_RUNTIME_SEAM_BEFORE_P2_0_GUARD_PASSES = YES
```

先做：把 enforcement 扩到 `runtime-expectation.js` / `runtime-behavior-effect.js`，
区分 LEGITIMATE_METADATA / APPROVED_P2_INTERNAL_SEAM / FORBIDDEN_WIRING；
既有只读自述（`predictionErrorLive` / `Calls` / `Blocker`）**不得**变红，
新增未批准的（结算调用、结算状态字面量、第二条 seam、browser 提交）**必须**被抓。
10 类对抗样本全部 CAUGHT。**此后**才写 registry seam。

**P2 期间发现并就地冻结的两件事（诚实登记）**

```
① `superseded` 是**既有 delivery 词表**（abortQueue reason）与 P2 生命周期状态的碰撞。
   ⇒ 逐面登记 SETTLEMENT_LITERAL_COINCIDENCES，而不是全局放宽 detector。
② 归一化串坐标**不能**直接映射回原始行号（会指到无关的行）。
   ⇒ 新增 semanticSpanSites()（原始坐标），并修掉 capability/granted-token 的行号报告。
```

**下一相位门**

```
NEXT_ALLOWED_PHASE = P3
P3 = Settlement Engine
   + seven-state state machine
   + directional authority consumption（support / conflict）
   + ordinal Prediction Error
   + internal audit record
P3 **仍然**不得：写 memory / relationship、暴露 UI/prompt/export、
                 新增 durable 表（calibration ledger 需要单独裁决）、回写 confidence。
本轮**未**进入 P3。
```

### I.13 P3 出口状态（Settlement Engine · 已完成）

```
P3_STATUS                    = COMPLETE
SETTLEMENT_ENGINE_LIVE       = YES
LIVE_SETTLEMENT              = YES
SETTLEMENT_STATE_AUTHORITY   = DETERMINISTIC_POLICY_ENGINE（唯一）
STATES                       = 7（pending / matched / missed / mixed /
                                  expired_unobserved / unresolvable / superseded）
LEGACY_RESULT_ADAPTER        = NONE
T8_TOTALITY                  = TOTAL_FUNCTION（320 格全枚举）
PREDICTION_ERROR             = ORDINAL_ONLY
PREDICTION_ERROR_METRIC      = null
RELATION_CLASSIFICATION      = MECHANICAL_ONLY（statement 需要 Evidence Matcher → P5）
CALIBRATION_LEDGER_LIVE      = NO
CALIBRATION_APPLIED_TO_LIVE  = NO
SETTLEMENT_DISCLOSURE_V1     = INTERNAL_AUDIT_ONLY
MODEL_CALLS_ADDED            = 0
DURABLE_WRITES_ADDED         = 0
MEMORY_WRITE_FROM_SETTLEMENT = FORBIDDEN
RELATIONSHIP_WRITE_FROM_SETTLEMENT = FORBIDDEN
RECALL_ENVELOPE_CHANGED      = NO
UI_DISCLOSURE_CHANGED        = NO
```

**新增文件**

```
assets/js/memory-recall/prediction-settlement-core.js    纯状态机（T0–T8 + ordinal PE 查表）
services/home-node/runtime-prediction-settlement.js      runtime 持有者（一次性 · 有界 · 进程内存）
tests/test_prediction_settlement_core.js                 81 条断言
```

**修改文件（P3 范围内）**

```
assets/js/memory-recall/prediction-record-core.js        P3.0 attribution 三态（additive）
services/home-node/runtime-prediction-registry.js        attribution 透传（生产不传 ⇒ unknown）
services/home-node-service.js                            **唯一**装配路径 + 导出
tests/helpers/runtime-seam-guard.js                      P3 结算权威面审计 + assembly 批准
tests/test_prediction_error_seam_guard.js                新增 §I（P3 seam，55 条）
tests/test_outcome_observation_authority.js              K6 相位迁移：零消费者 → **恰好一个**具名消费者
tests/test-all.js                                        注册 P3 suite
docs/contracts/memory/RECONSTRUCTIVE_MEMORY_CONTRACT.md  addendum (q-14) · (q-15)
```

**P3 的两处相位迁移（收窄，不是放宽）**

```
① OutcomeObservation core 的生产消费者：0 → **恰好 1**（Settlement Engine，
   理由 (q-12) SAME_MODULE_INSTANCE_REQUIRED：消费 gate 输出而不是重判 authority）。
② runtime-prediction-settlement 从 FUTURE_RESERVED_SEAM → APPROVED_P3，
   **只有**两个权威面 + 一个装配路径；recall / interpretation / expectation /
   behavior-effect / browser / memory-store / relationship 仍然零结算能力。
```

**P3 诚实登记的边界**

```
基于 statement 的主观预测（preference / latent_state / relational）在 P3
**不可能**被决定性结算 —— 因为 statement 的 support/conflict 分类需要语义判断，
而 EVIDENCE_MATCHER_INVOCATION = OFF（禁止模型补判断）。
这不是策略缺失：policy 表允许，能力面未开放。P5 才启用 matcher。
```

**下一相位门**

```
NEXT_ALLOWED_PHASE = P4
P4 = Calibration Ledger
   + cross-prediction counts
   + calibrationConfidence derivation
   + 初期**仍然**不写回 live
本轮**未**进入 P4。
```

### I.14 P4 出口状态（Calibration Ledger · 已完成）

```
P4_STATUS                     = COMPLETE
CALIBRATION_LEDGER_LIVE       = YES
CALIBRATION_LEDGER_LIFETIME   = SESSION_ONLY
DURABLE_CALIBRATION_HISTORY   = NO_V1
CALIBRATION_AUTHORITY_SOURCE  = P3_SETTLEMENT_RECORD
P4_REOPENS_SETTLEMENT_AUTHORITY = NO
PARTITION_KEY                 = { predictionType, targetDomain }
CROSS_PARTITION_TRANSFER      = FORBIDDEN
GLOBAL_PREDICTION_ACCURACY    = FORBIDDEN
CANONICAL_COUNTS_NAME         = calibrationCounts
LEGACY_RESULT_ADAPTER         = NONE
NUMERIC_PE_AGGREGATION        = FORBIDDEN
CALIBRATION_CONFIDENCE        = null
CALIBRATION_CONFIDENCE_BASIS  = NULL_BY_CONTRACT_NO_FROZEN_DERIVATION_RULE
CALIBRATION_APPLIED_TO_LIVE   = NO
EXPECTATION_WRITEBACK         = NONE
INTERPRETATION_WRITEBACK      = NONE
CALIBRATION_DISCLOSURE_V1     = INTERNAL_AUDIT_ONLY
MODEL_CALLS_ADDED             = 0
DURABLE_WRITES_ADDED          = 0
MEMORY_WRITE_FROM_CALIBRATION = FORBIDDEN
RELATIONSHIP_WRITE_FROM_CALIBRATION = FORBIDDEN
RECALL_ENVELOPE_CHANGED       = NO
UI_DISCLOSURE_CHANGED         = NO
```

**新增文件**

```
assets/js/memory-recall/prediction-calibration-core.js   纯计数核心（分区 · counts · ordinal PE）
services/home-node/runtime-prediction-calibration.js     有界会话内持有者（partition + dedupe）
tests/test_prediction_calibration_ledger.js              88 条断言
```

**修改文件（P4 范围内）**

```
services/home-node/runtime-prediction-settlement.js      P3 provenance seal（module-private capability）
assets/js/memory-recall/prediction-settlement-core.js    settlement 记录带 admittedTargetDomains / targetDomain
services/home-node-service.js                            **唯一**装配路径 + 导出
tests/helpers/runtime-seam-guard.js                      P4 校准权威面审计 + writeback/全局精度/legacy key 检测
tests/test-all.js                                        注册 P4 suite
docs/contracts/memory/RECONSTRUCTIVE_MEMORY_CONTRACT.md  addendum (q-16)
```

**P4 的相位迁移（批准一条新 seam，其余全部保持禁止）**

```
runtime-prediction-calibration  FUTURE_RESERVED_SEAM → APPROVED_P4
唯一消费 seam = Settlement Engine → Calibration Ledger
```

**为什么 `calibrationConfidence = null` 是契约结论而不是偷懒**

契约 §H / §C.3 已冻结 `calibrationConfidence = null`（v1 恒 null），
G24 要求断言其恒 null 且无写回路径，G27 禁止造未冻结的数值。
同时契约**没有**冻结 sample threshold，也没有冻结 ordinal→confidence 的派生规则
⇒ 只能实现 counts + ordinal bucket + `sampleStatus`，**不得**发明比率公式或无来源阈值。
这是 §11 的 **Option B**，且 `NO_FORMULA_INVENTION_TO_AVOID_NULL = YES`。

**P4 诚实登记的边界**

```
preference / latent_state / relational 的 partition 在当前 runtime 下是
**capability gap**（statement 的 relation 分类需要 Evidence Matcher，P5 才启用），
不是"表现差"。Ledger 用 capabilityCoverage.status = 'capability-gap' 表达，
并用 noEligibleSample 与 CAPABILITY_GAP 分开表达 —— 空数据绝不报成低置信。
```

**下一相位门（**不**自动进入）**

```
NEXT_PHASE_REQUIRES_OWNER_RULING = YES
候选（本轮**一个都没有**实现）：
  P5-A Calibration Application
  P5-B Evidence Matcher
  P5-C Durable Prediction / Settlement / Calibration History
```

### I.15 P4-R1 出口状态（Calibration Reconciliation · 已完成）

```
P4_R1_STATUS                  = COMPLETE
P4_STATUS                     = COMPLETE
P4_FREEZE                     = FROZEN
NEW_RUNTIME_SEAMS             = 0
```

**R1 · capabilityCoverage 语义修复**

```
policyPermission × runtimeCapability × sampleAvailability = 三个正交维度
NO_SAMPLE != BAD_PERFORMANCE != POLICY_FORBIDDEN != CAPABILITY_GAP
empty-but-policy-allowed ⇒ settleable-by-current-runtime（**不再**是 not-policy-allowed）
not-policy-allowed 只在 policy 本身禁止时出现
```

**R2 · P3 reachability gate**

```
CALIBRATION_INPUT_MUST_BE_REACHABLE_FROM_P3 = YES
P4_REOPENS_SETTLEMENT_AUTHORITY = NO · P4_REJUDGES_SETTLEMENT = NO
ONE_POLICY_TABLE_MULTIPLE_CONSUMERS = YES
reachability authority = prediction-settlement-core.js#DECISIVE_AUTHORITY_SOURCES
                         （与 P2 POLICY_TABLE[type].strongestAuthority 逐字一致）
ingest 顺序 = provenance → calibrationCounted → reachability → partition → idempotency → count
reasonCode  = settlement-combination-unreachable
```

**根因修复（P3 侧同步收紧，不只是 P4 拦）**

```
P3 computeSettlement 现在同时要求：
   gate.effective === 'ELIGIBLE'            （matrix 天花板）
   ∧ source ∈ DECISIVE_AUTHORITY_SOURCES[type]  （decisive authority）
⇒ preference / latent_state / relational 的行为证据**永远** non-decisive
⇒ preference × user_behavior × matched 在 P3 侧就**不再可产生**
```

这解释了原 P4 fixture（`preference × user_behavior` 3 matched + 1 missed）的来源：
P3 只看了 matrix、没看 decisive authority sources。已在 P3 关闭，fixture 已替换为可达分区。

**R3 · multi-domain**

```
MULTI_DOMAIN_CALIBRATION_PARTITION_V1 = FORBIDDEN
EXACTLY_ONE_ADMITTED_TARGET_DOMAIN_REQUIRED_FOR_CALIBRATION_COUNT = YES
0 域 ⇒ partition-unresolvable-no-domain（拒绝）
1 域 ⇒ 可计数
>1 域 ⇒ diagnostics-only · changed=false · partition-unresolvable-multi-domain
diagnostics = audit only（participatesInCalibrationCounts = false）
分区解析失败 MUST NOT 被写成 settlement state mixed
```

**不可达组合（v1）**

```
preference  × user_behavior × matched|missed × counted ⇒ UNREACHABLE_V1
latent_state × user_behavior × matched|missed × counted ⇒ UNREACHABLE_V1
relational  × user_behavior × matched|missed × counted ⇒ UNREACHABLE_V1
statement 型 explicit report（preference/latent_state/relational 主观域）⇒ CAPABILITY_GAP
```

**本相位不动的量**

```
calibrationCounts = 不变 · calibrationConfidence = null · CALIBRATION_APPLIED_TO_LIVE = NO
exactly-once 口径 = YES_WITHIN_BOUNDED_LEDGER_WINDOW · holder 边界 = 不变
MODEL_CALLS_ADDED = 0 · DURABLE_WRITES_ADDED = 0
```

**下一相位门**

```
NEXT_ALLOWED_PHASE = P5-B（Evidence Matcher）
owner ruling：
  P5-A Calibration Application = NOT NEXT
      理由：calibrationConfidence = null ⇒ **没有**合法可应用的东西
  P5-C Durable History        = NOT NEXT
      理由：durable lifecycle authority 尚未设计（(q-16.5) 的 authority inversion 风险）
  P5-B Evidence Matcher       = NEXT CANDIDATE
      理由：它是 preference / latent_state / relational capability gap 的当前唯一 blocker
本轮**未**进入 P5-B。
```

### I.16 P5-B 出口状态（Evidence Matcher · 已完成）

```
P5_B_STATUS                     = COMPLETE
EVIDENCE_MATCHER_ROLE           = ADVISORY_SEMANTIC_CLASSIFIER_ONLY
RELATION_AUTHORITY              = ADVISORY_ONLY
STRENGTH_HINT_AUTHORITY         = NONE
MATCHER_FAILURE_RELATION        = ambiguous
MATCHER_RETRY                   = 0 · MATCHER_CACHE = NONE_V1
EVIDENCE_MATCHER_ENABLED_DEFAULT = false
MATCHER_CALLS_ADDED             = conditional
SOURCE_PROVENANCE_IMMUTABLE     = YES
TARGET_DOMAIN_IMMUTABLE         = YES
PREDICTION_TYPE_IMMUTABLE       = YES
SETTLEMENT_STATE_AUTHORITY      = P3_ONLY
ONLY_MATCHER_RUNTIME_MINTS_VALID_EVIDENCE_MATCH = YES
DURABLE_WRITES_ADDED            = 0
```

**新增文件**

```
assets/js/memory-recall/evidence-match-core.js    纯 schema / validator / 最小输入构建
services/home-node/runtime-evidence-matcher.js    唯一 model call 面 + capability seal
tests/test_evidence_matcher.js                    91 条断言
```

**修改文件（P5-B 范围内）**

```
assets/js/memory-recall/prediction-settlement-core.js  只替换 unclassifiable；仅消费 relation
services/home-node/runtime-prediction-settlement.js    matcher-aware 唯一入口 + 调用计数
services/home-node-service.js                          先建 matcher 再建 settlement（唯一 seam）
tests/helpers/runtime-seam-guard.js                    P5 matcher 权威面审计 + 浏览器禁令
tests/test_prediction_settlement_core.js               N2 相位迁移（API 增一个入口）
tests/test-all.js                                      注册 P5-B suite
docs/contracts/memory/RECONSTRUCTIVE_MEMORY_CONTRACT.md  addendum (q-18)
```

**capability gap 关闭（matcher 启用后）**

```
reachable-policy-only → reachable-now：
  preference  × user_preference
  latent_state × latent_state
  relational  × relationship
仍然 unreachable：
  preference  × user_behavior
  latent_state × user_behavior
  relational  × user_behavior
    （DECISIVE_AUTHORITY_SOURCES 只允许 EXPLICIT_USER_REPORT ⇒ 行为路径永不 decisive）
```

**生产行为（诚实登记）**

```
EVIDENCE_MATCHER_ENABLED_DEFAULT = false
  ⇒ 生产**零**新增模型调用；statement 保持 unclassifiable；
    主观域 partition 保持 capability-gap。
启用后：每条 statement observation 至多 **一次**调用（无缓存、无重试）；
  失败一律 ambiguous ⇒ 不会产生 decisive settlement。
★ **不**声称 MODEL_CALLS_ADDED = 0 作为永久不变量。
```

**下一相位门（**不**自动进入）**

```
NEXT_PHASE_REQUIRES_OWNER_RULING = YES
届时重新评估：
  P5-A Calibration Application
  P5-C Durable History
  Evidence Matcher hardening / closure
```

### I.17 P5-B-R1 出口状态（Matcher Enablement Closure · 已完成）

```
P5_B_R1_STATUS                     = COMPLETE
P5_B_STATUS                        = COMPLETE
P5_B_FREEZE                        = FROZEN
EVIDENCE_MATCHER_CAPABILITY        = LIVE
EVIDENCE_MATCHER_ENABLED_DEFAULT   = false（**保持**）
PRODUCTION_ENABLEMENT_READY        = YES（能力就绪；启用与否是 owner ruling）
NEW_RUNTIME_SEAMS                  = 0
```

**R1 · 三层 capability（compiled ≠ enabled ≠ production-settleable）**

| compiled | enabled | policyAllowed | attributionAvailable | runtimeClassifiable | productionSettleable |
|---|---|---|---|---|---|
| false | – | – | – | false | false |
| true | false | – | – | **false** | false |
| true | **true** | true | **false** | **true** | **false** |
| true | true | true | true | true | **true** |
| true | true | **false** | – | false | false |

具名 gap 原因：`matcher-not-present` · `matcher-disabled` · `statement-relation-unavailable` ·
`attribution-unknown` · `policy-forbidden` · `source-not-decisive` · `no-eligible-sample`。

**R2 · P4 capabilityCoverage 跟真实 enablement + attribution 一致**

```
四个正交维度：policyAllowed · runtimeClassifiable · productionSettleable · sampleAvailability
COMPILED_BUT_DISABLED != RUNTIME_CLASSIFIABLE != PRODUCTION_SETTLEABLE
(q-17.1) 的三条"不相等"全部保持
```

**重要真实状态**：生产 projection 目前恒 `behaviorEffectAttributionStatus = 'unknown'`
⇒ 主观域 `productionSettleable` **恒为 false**，即使 matcher 已编译且已启用。
`(q-14)` 归因门**不因 matcher 而放宽**。

**R3 · matcher idempotency / bounded holder**

```
MATCHER_AT_MOST_ONCE_PER_MATCH_KEY_WITHIN_SESSION = YES
MATCH_KEY = stableToken(predictionSemanticFingerprint | observationFingerprint | matcherVersion | relationSchemaVersion)
holder = SESSION_ONLY · 256 entries · 10 min TTL · FIFO 淘汰 · eviction diagnostics
DURABLE_MATCHER_CACHE = NO
只缓存 runtime-minted sealed EvidenceMatch
failure memo policy = SUCCESS_AND_FAILURE（CALLER_RETRY_CANNOT_UPGRADE_RELATION = YES）
```

**R4 · hard call budget**

```
maxMatcherCallsPerSettlementAttempt = 4 · maxMatcherCallsPerPrediction = 4 · maxMatcherCallsPerTurn = 8
MATCHER_CALL_BUDGET_AUTHORITY = SYSTEM_CONFIG（evidence 不得携带 budget / retry / model）
BUDGET_EXHAUSTION_RELATION = ambiguous
顺序：needed → MatchKey → memo（命中不扣预算）→ budget → 一次调用 → validate → seal → memoize
机械可判路径不受预算影响
```

**R5 · input schema 口径归一**

```
MATCHER_INPUT_TOP_LEVEL_KEY_COUNT = 5
MATCHER_INPUT_TOP_LEVEL_KEYS = [schemaVersion, predictionId, prediction, observation, scope]
```

之前报告称 "four top-level keys" 却列出五个 —— **报告**是错的；
实现 / 测试 / 契约本来就一致为五。`CODE == TEST == CONTRACT == REPORT` 已由测试机械断言。
修 key count **未**扩大 input（minimization 全部保持）。

**下一相位门（**不**自动进入）**

```
NEXT_PHASE_REQUIRES_OWNER_RULING = YES
待决问题（**不**自行修改默认值）：
  Should EVIDENCE_MATCHER_ENABLED_DEFAULT remain false or be explicitly enabled?
明确**不**进入：P5-A Calibration Application · P5-C Durable History
```

### I.18 P5-B2 出口状态（BehaviorEffect Attribution Authority · 已完成）

```
P5_B2_STATUS                        = COMPLETE
BEHAVIOR_EFFECT_ATTRIBUTION_AUTHORITY = RUNTIME_BEHAVIOR_EFFECT（ONE EFFECT FACT OWNER）
ATTRIBUTION_AUTHORITY_LIVE          = YES
ATTRIBUTION_LEDGER_LIFETIME         = SESSION_ONLY
KNOWN_NONE_REQUIRES_COMPLETE_COVERAGE = YES
ABSENCE_OF_EFFECT_RECORD_IS_NOT_KNOWN_NONE = YES
PREDICTION_INFLUENCED_SYSTEM_FALSE_REQUIRES_COMPLETE_TRACE = YES
ATTRIBUTION_SNAPSHOT_AT_PREDICTION_CREATION = IMMUTABLE
EVIDENCE_MATCHER_ENABLED_DEFAULT    = false（**保持**）
MATCHER_DEFAULT_CHANGED             = NO
MODEL_CALLS_ADDED                   = 0
DURABLE_WRITES_ADDED                = 0
NEW_RUNTIME_SEAMS                   = 0
```

**Runtime audit（file:line，先审计后设计）**

```
creation    : services/home-node/runtime-behavior-effect.js#deriveAndHold（唯一入口）
consumer    : runtime-recall.js:853（唯一调用方）
consume     : runtime-behavior-effect.js#consumeForTurn（held.delete ⇒ 单次消费）
              runtime-recall.js:282（唯一调用方）
expiry      : runtime-behavior-effect.js#sweep（HOLDER_TTL_MS）
eviction    : runtime-behavior-effect.js#evictOverflow（MAX_HELD_BEHAVIOR_EFFECTS）
holder      : held = new Map()（key = characterId|conversationId|sourceTurn）
record      : { characterId, conversationId, sourceTurn, effect, createdAt }
identity    : **原先没有** effect instance id（同 key 二次派生只体现为 counters.replaced）
```

**审计发现（真实 gap，本轮闭合）**

```
· held 只保存**当前待取**集合，consumed 即删除
  ⇒ 它无法回答"过去某刻有没有干预在生效"，也无法区分
    "从未存在" 与 "已被消费"
· 没有任何枚举 API ⇒ coverage 无法被证明完整
· 淘汰（evictOverflow）是一条**未观察到终态**的消失路径
```

⇒ 本轮在同一个 owner 内加一个 **session-only 有界账本**，在四个 seam 上记录
instance 的 startedAt / endedAt / endReason；淘汰一律把账本**永久降级**为
`partial`（此后 `known-none` 不可声称）。

**capability gap 的真实闭合**

```
attribution = known-none（complete coverage）
  ⇒ productionSettleable 第一次可以为 true
attribution = known-present（存在 relevant active effect）
  ⇒ 仍禁止独立校准确认（calibrationCounted = false）
attribution = unknown（authority 缺席 / coverage 不完整）
  ⇒ fail closed（(q-14) 不变）
```

**下一相位门**

```
NEXT_PHASE_REQUIRES_OWNER_RULING = YES
attribution authority 已闭合 ⇒ 可提出：
  Should EVIDENCE_MATCHER_ENABLED_DEFAULT remain false or be explicitly enabled?
但**不**自行启用；**不**进入 P5-A / P5-C
```

### I.19 P5-B3-A 出口状态（Attribution Coverage Closure · 已完成）

```
P5_B3_A_STATUS                          = COMPLETE
ATTRIBUTION_AUTHORITY_LIVE              = YES
ATTRIBUTION_COVERAGE_READY              = YES
ACTIVE_EFFECT_AUTHORITY                 = COMPLETE
HISTORY_RETENTION                       = BOUNDED_SESSION_ONLY
CAPACITY_EVICTION_IS_OBSERVED_TERMINATION = YES
OBSERVED_TERMINATION_PRESERVES_ACTIVE_COVERAGE = YES
UNOBSERVED_DISAPPEARANCE_DEGRADES_COVERAGE     = YES
PREDICTION_ATTRIBUTION_SNAPSHOT_IMMUTABLE      = YES
EVIDENCE_MATCHER_ENABLED_DEFAULT        = false（**保持**）
MATCHER_DEFAULT_CHANGED                 = NO
OUTCOME_OBSERVATION_PRODUCTION_PRODUCER = NOT_LIVE
MODEL_CALLS_ADDED                       = 0
DURABLE_WRITES_ADDED                    = 0
NEW_RUNTIME_SEAMS                       = 0
```

**Root cause（旧错误模型）**

```
evictOverflow() 删除了 active entry，同时把整个账本标记为 degraded
  ⇒ 一次正常容量淘汰就让 **整个 session** 永久失去 known-none authority
两处错误：
  ① 把 canonical owner **自己执行**的淘汰误当成"未观察的消失"
  ② 用**一个**有界账本同时承担"活跃 authority"与"历史 retention"
     ⇒ 活跃事实被历史容量压力挤掉
```

**修复**

```
① 容量淘汰先机械终止（endedAt / endReason='capacity-evicted'）再移出活跃集合
   —— 审计已确认：被淘汰的 entry **永远不会**再被 consumeForTurn 使用，
      因此容量淘汰在产品语义上确实就是该 effect 的终止（§9 前提成立）。
② active（与 holder 一一对应，不设独立容量）与 closed history（有界）分层
   —— 活跃集合永远完整；历史裁剪只推进 effectiveCoverageFloor。
③ UNOBSERVED_DISAPPEARANCE 收窄为真正的 invariant 破坏 / 状态损坏。
```

**验收要点**

```
capacity eviction 之后 present-time query：coverage = complete，status = known-none
  （旧模型此处为永久 partial）
历史查询仍可能 partial（at < effectiveCoverageFloor），但**不**影响当前/未来
PredictionRecord 的 sealed attribution snapshot 永不被回写
```

**下一相位门**

```
NEXT_ALLOWED_PHASE = P5-B3-B · OutcomeObservation Production Authority
本轮**未**进入；**不**建议先开启 Matcher
```

---

## 附 · 本文件与既有 contract 的合并方式

```
契约文件                         处置                                            状态
RECONSTRUCTIVE_MEMORY_CONTRACT.md   ★ **只追加** addendum (q)                      ✅ P0 已完成
                                      （house style：每个相位都是"追加，不改写"）
                                      落点：文件末尾（原 §40 之后）
                                      标题：`## 附录 (q) · Prediction Error · Contract Reconciliation`
                                      内容：(q-0) 六项 owner ruling
                                            (q-1) §28.2 authority supersession
                                            (q-2) 七状态 vocabulary（含 mixed / expired_unobserved 新定义 + T8 有序判定）
                                            (q-3) OutcomeObservation namespace boundary
                                            (q-4) Observation Authority = source × domain
                                            (q-5) 四类 prediction policy + MODEL_MAY_NOT_CHOOSE_PREDICTION_TYPE
                                            (q-6) calibration 命名归一（calibrationEvidence ≡ calibrationCounts；calibrationConfidence 是另一个量）
                                            (q-7) OUTCOME_OBSERVATION_MUST_POSTDATE_PREDICTION
                                            (q-8) GAP registry（status / owner phase / must-fix-before）
                                            (q-9) 负面清单（本附录没改变的东西）
PREDICTION_ERROR_AUTHORITY_CONTRACT.md（本文件）  设计冻结提案，供 (q) 引用          ✅ P0 已收口（§I）
docs/P26-2-OBSERVATION-CONTRACT.md    ★ **不改**（其整文件 hash 与 5 函数 API 被守卫冻结）  ✅ 未触碰
docs/P21-R4-PROD-1-COGNITIVE-CONTROL-PLANE.md  ★ 落地时需追加新策略位的登记          ⏳ P2/P3
tests/helpers/runtime-seam-guard.js  ★ 相位迁移（带注释 + 对抗样本），不是放宽        ⏳ P1.5
```

**P0 验证（已执行）**

```
node tests/test_reconstructive_memory_contract.js  → PASSED · 87 assertions green
node tests/test_expectation_shadow.js              → PASSED · 95 assertions green
```

### I.20 P5-B3-J-R2 · Calibration `productionSettleable` Reconciliation

**Canonical formula**

```
PRODUCTION_SETTLEABLE_CANONICAL_FORMULA
  = policyAllowed
    ∧ runtimeClassifiable
    ∧ attributionAuthorityAvailable
```

This answers whether a valid P2 Prediction of this type/mode has the current
policy, relation-classification capability, and attribution authority needed to
reach a decisive P3 Settlement. P3 still checks the exact evidence source,
target-domain authority matrix, attribution status, and any per-Prediction
opportunity before deciding a SettlementRecord. The formula does not state that
such a record or eligible sample currently exists.

`noEligibleSample`, `capabilityGap`, attribution history coverage,
`calibrationConfidence`, and `calibrationAppliedToLive` do not participate in
this formula. `capabilityGap = policyAllowed ∧ ¬runtimeClassifiable`; therefore
an empty partition cannot create a gap, and a denied policy is reported as
`not-policy-allowed` even if a classifier is present.

**Matcher rule**

```
P4 runtimeClassifiable
  = P3 mechanical mode classification
    ∨ (statement classification ∧ matcher capability present ∧ matcher enabled)

Matcher taxonomy runtimeClassifiable
  = matcher capability present ∧ matcher enabled ∧ policyAllowed ∧ sourceDecisive
```

The matcher taxonomy already folds policy and source permission into its
`runtimeClassifiable`; its `runtimeClassifiable ∧ attributionAuthorityAvailable`
expression is equivalent to the canonical normalized formula above. Matcher
enablement is not a global gate: a mechanically classifiable structured
preference token remains production-settleable while the matcher is disabled.
Statement-based relation paths remain unclassifiable while the matcher is off.

**P4 formula correction and change boundary**

The pre-R2 P4 pure core used:

```
runtimeClassifiable ∧ attributionAuthorityAvailable
```

It omitted the separately reported `policyAllowed` conjunct required by q-19.4.
P5-B3-J-R2 adds that conjunct to the read-only P4 capability projection and
only reports `attribution-unknown` when attribution authority is actually absent.
All four current P3 prediction types have at least one decisive authority source,
so their valid production values are unchanged. An unrecognized/disallowed type
with a mechanically classifiable mode now correctly remains
`productionSettleable = false`.

No P3 Settlement semantics or P4 `ingestSettlement()` eligibility, counts,
reachability, partitioning, or dedupe behavior changed. This correction does not
enable the Evidence Matcher, add a prediction producer, or make the capability
formula depend on sample count.

**Structured preference and per-type status**

```
event
  decisive sources: CANONICAL_RUNTIME / USER_BEHAVIOR
  exclusive_outcome and window_closure_negative: mechanically classifiable
  conditional P4 capability with policy + attribution authority: true
  current G1 structured-expectation producer: does not create event predictions

preference
  decisive source: EXPLICIT_USER_REPORT
  exclusive_outcome token relation: mechanically classifiable; matcher not needed
  current structured producer: enabled; opportunity authority: live
  production support -> matched; permitted conflict + satisfied opportunity -> missed
  P4 capability with policy + attribution authority: true

latent_state
  decisive source: EXPLICIT_USER_REPORT
  explicit_denial statement relation: matcher required; matcher is disabled
  current structured producer: disabled
  current P4 runtimeClassifiable / productionSettleable: false

relational
  decisive source: EXPLICIT_USER_REPORT
  explicit_denial statement relation: matcher required; matcher is disabled
  current structured producer: disabled
  current P4 runtimeClassifiable / productionSettleable: false
```

All four P2 types currently require opportunity evidence for a negative
settlement. Opportunity is a directional, per-Prediction P3 gate: it can block a
particular `missed` record without redefining the type-level classifier
capability. Preference's structured report path has a production opportunity
authority; `productionSettleable` does not claim that every type's opportunity
has already been satisfied.

The old q-19.3 statement that all subjective types are necessarily
`productionSettleable = false` described the earlier production state in which
subjective attribution was always unknown. It is superseded by the live
structured-preference path and this formula. q-19.1 remains applicable to the
matcher-required statement path; it does not make Matcher a prerequisite for
mechanical preference tokens.

**Verification**

```
MATCHER_ENABLED_DEFAULT = false
PREFERENCE_MECHANICAL_WITH_MATCHER_OFF = productionSettleable true
STATEMENT_PATH_WITH_MATCHER_OFF = productionSettleable false
NO_ELIGIBLE_SAMPLE_ORTHOGONAL = YES
POLICY_FORBIDDEN_AND_MECHANICALLY_CLASSIFIABLE = productionSettleable false
P3_SETTLEMENT_CHANGED = NO
P4_INGEST_CHANGED = NO
CALIBRATION_CONFIDENCE = null
CALIBRATION_APPLIED_TO_LIVE = NO
P5_B3_J_R2_STATUS = COMPLETE
P5_B3_J_R2_FREEZE = FROZEN
```

Runtime semantic change: **YES**, limited to the P4 read-only capability formula
and its reason reporting. No supported production prediction type changes value;
the new policy conjunct closes the invalid/disallowed pure-core input case.

### I.21 Producer and opportunity scope clarification

The formula is conditional on an existing canonical P2 Prediction; it is not a
P2 production-type enablement flag. The current structured expectation producer
emits `preference` only. All four prediction types require opportunity evidence
for negative settlement, while the current production opportunity authority
accepts scoped preference choices only. J-R2 therefore does not claim production
negative settlement for event, latent-state, or relational types. Their
opportunity remains a per-record P3 directional gate, separate from the P4
classifier capability formula.

### I.22 P5-B3-D5 · Prediction-Specific TurnTerminal Directional Semantics

**D3 taxonomy audit**

`execution.js#finalize` emits the literal outcomes `completed`,
`credential-unavailable`, `empty-output`, and `store-write-failed`.
`execution.js#classify` normalizes abort, timeout, HTTP/stream failures to
`abort`, `timeout`, or `provider-error`; it also passes through other `error.kind`
values. The canonical runtime therefore has a recognized set plus an open
passthrough. `unknown` and unrecognized kinds remain terminal facts, but are not
directionally classifiable. D5's recognized mechanical subset is:

```
completed · credential-unavailable · empty-output · store-write-failed ·
abort · timeout · cancelled · provider-error
```

The existing P2 `event` type and `exclusive-outcome` mode can carry an expected
token. D5 uses the P1-owned runtime-state token vocabulary:

```
runtime.turn_terminal.<recognized-outcomeCode>
```

The old generic `runtime.turn_terminal` token remains an admissible fact marker,
but by itself is not a complete proposition and produces `unclassifiable` in P3.
Unknown suffixes likewise cannot support or conflict.

**Relation owner and gates**

```
RealityEvent / P1 = fact and admission only
P3 classifyRelation = terminal support / conflict / irrelevant / unclassifiable
P1 pairing = P2 sourceExpectationRef.turnId == RealityEvent.entityId
              plus exact character / conversation and prediction-window binding
```

Within the recognized terminal family, exact code equality is `support`; a
different recognized code is `conflict`, because D3's terminal seam permits one
terminal decision per turn. A terminal token against another runtime proposition
is `irrelevant`. Wrong source/domain and unknown terminal codes fail closed.
This rule is specific to `event` / `runtime_state`; it does not make unrelated
`exclusive-outcome` tokens conflict.

P1 maps `RealityEvent.body.outcomeCode` into the existing P1 runtime-state token
registry under the exact `runtime.turn-execution` provenance. The RealityEvent
still contains only the factual `outcomeCode` body; it carries no relation,
settlement state, prediction ID, or opportunity result. RealityEvent identity
remains independent of prediction; each P1 projection retains its existing
`realityEventId + predictionId + projectionVersion` identity.

**Opportunity boundary**

```
TURN_TERMINAL_FACT != OPPORTUNITY_SATISFIED
exact/mismatched terminal relation is mechanical without Matcher
conflict relation + current event opportunity UNKNOWN -> no P3 missed
```

The current opportunity authority recognizes scoped preference choices, not
event `runtime-execution` opportunities. D5 proves the P3 relation `conflict`
but does not manufacture `SATISFIED`; the negative settlement remains
`unresolvable` / not calibration-counted until an event opportunity authority is
approved. The exact support path is production-shaped and reaches P3 `matched`;
P4 automatically ingests that matched SettlementRecord.

```
EVIDENCE_MATCHER_ENABLED_DEFAULT = false · MATCHER_CALLS = 0
EVENT_RELATION_CAPABILITY = LIVE
EVENT_PRODUCTION_PREDICTION_CREATION = NOT_YET_LIVE (G1 remains preference-only)
P3_SETTLEMENT_AUTHORITY_CHANGED = NO
P4_INGEST_SEMANTICS_CHANGED = NO
CALIBRATION_CONFIDENCE = null · CALIBRATION_APPLIED_TO_LIVE = NO
D5_DIRECTIONAL_RELATION = COMPLETE
D5_DECISIVE_NEGATIVE_SETTLEMENT = BLOCKED_BY_EVENT_OPPORTUNITY
P5_B3_D5_STATUS = COMPLETE
P5_B3_D5_FREEZE = FROZEN
```

### I.23 P5-B3-D5-R1 · Event Negative Opportunity Authority

**Terminal finality audit**

P2 event Predictions require an opportunity for negative settlement and derive
the existing `runtime-execution` opportunity kind. The event opportunity is
completed by the canonical terminal fact for the exact predicted turn; relation
is not consulted to establish it.

D3 `execution.js` owns turn identity and terminal finality. It creates the turn
ID internally, freezes the turn context, and routes each post-instance terminal
branch through one `finalize()` / `settleTurnOutcome()` seam before notifying the
RealityEvent source. The session holder suppresses duplicate finalization. The
same `requestId` is idempotent at the store before a new turn is minted; another
in-flight turn in that conversation is refused as `busy`; cancellation and
timeout are terminal branches, not later replacements. The holder and RealityEvent
registry are session-bounded, so R1 proves opportunity only while the sealed event
is present in the current authority, never from elapsed time or missing history.

**Independent event opportunity owner**

`runtime-event-opportunity-authority` accepts only a P1-built observation whose
first evidence reference resolves to the same sealed RealityEvent held by the
RealityEvent authority. It verifies the registered TurnTerminal source identity,
known terminal outcome, terminal event ID, `runtime_state` target, prediction
type/mode/family, same character and conversation, exact
`sourceExpectationRef.turnId == RealityEvent.entityId`, and event time within the
Prediction window. It returns an authority-sealed opportunity resolution; it
does not inspect support/conflict or produce a Settlement state.

The event opportunity identity is derived from terminal family, RealityEvent ID,
turn, character, conversation, and occurrence time. It contains no Prediction ID
or observation ID, so one finality fact can serve multiple valid Predictions for
the same turn. The type router keeps this owner separate from the existing
subjective preference opportunity authority.

```text
RELATION_AUTHORITY != OPPORTUNITY_AUTHORITY
conflict does not create opportunity
canonical recognized same-turn terminal finality → opportunity SATISFIED
no terminal observation → opportunity UNKNOWN
unknown terminal outcome → opportunity UNKNOWN / fail closed
wrong turn, character, conversation, proposition family, target, or window → UNKNOWN
```

P3 resolves opportunity independently, supplies its sealed opportunity object to
the existing P1 directional gate, and remains the only settlement authority. A
recognized terminal mismatch is therefore admitted as decisive conflict only
with the same canonical terminal opportunity; P3 can then produce `missed`.
Exact terminal match remains `matched`. P4 automatically ingests clean matched
and missed samples. BehaviorEffect attribution still suppresses calibration
counting when the sample is self-influenced.

```
EVENT_OPPORTUNITY_AUTHORITY = LIVE
TEST_MANUAL_OPPORTUNITY_INJECTION = 0
TEST_MANUAL_FEEDBACK_CALLS = 0
TEST_MANUAL_CALIBRATION_INGEST = 0
TERMINAL_SUPPORT = matched
TERMINAL_CONFLICT = missed (when clean and same-turn opportunity is satisfied)
NO_TERMINAL_FACT != OPPORTUNITY_SATISFIED
UNKNOWN_TERMINAL_OUTCOME = FAIL_CLOSED
EVIDENCE_MATCHER_ENABLED_DEFAULT = false · MATCHER_CALLS = 0
P3_SETTLEMENT_AUTHORITY_CHANGED = NO
P4_SEMANTICS_CHANGED = NO
CALIBRATION_CONFIDENCE = null · CALIBRATION_APPLIED_TO_LIVE = NO
EVENT_PRODUCTION_PREDICTION_CREATION = NOT_YET_LIVE
D5_DECISIVE_NEGATIVE_SETTLEMENT = LIVE
P5_B3_D5_R1_STATUS = COMPLETE
P5_B3_D5_R1_FREEZE = FROZEN
```

### I.24 P5-B3-G2 · Production Structured Terminal Event Projection

G1 already has `event` in the structured candidate kind vocabulary and P2 already
supports `event` / `exclusive_outcome`; G1's candidate payload and production
projection policy were preference-shaped. G2 appends one candidate union arm:

```text
{ kind: "event", eventFamily: "turn_terminal", expectedOutcome: <D5 outcome code> }
```

The model does not output a token or authority field. Runtime validates the fixed
family and asks P1's `turnTerminalTokenOfOutcomeCode` to construct
`runtime.turn_terminal.<code>`. P2's existing TYPE_TABLE derives `event` from
runtime-fixed `subject=system`, `predicate=will-occur`, and
`expectedOutcome.kind=exclusive-outcome`; P2 schema and TYPE_TABLE are unchanged.
Preference retains its G1 projection. `latent_state`, `relational`, and arbitrary
event families remain disabled.

G1 recall identity is not D3 execution identity. Therefore an event candidate is
registered only when runtime can resolve the currently active D3 turn whose
`requestCorrelationId` exactly matches the recall request, character, and
conversation. The event's `sourceExpectationRef.turnId` is taken from that active
immutable execution context. Missing, late, or mismatched binding skips the event
candidate; it is never attached to the recall turn or a neighboring execution.
Preference projection keeps its existing scope behavior. All candidates still use
the single `runtime-expectation.js → projectFromValidatedExpectation` call site.

```text
PRODUCTION_STRUCTURED_EVENT_PREDICTION = ENABLED
PRODUCTION_EVENT_PROJECTION_FAMILY = runtime.turn_terminal
MODEL_MAY_PROPOSE_TERMINAL_EVENT = YES
MODEL_MAY_MINT_EVENT_PREDICTION = NO
MODEL_MAY_DEFINE_TERMINAL_TOKEN_GRAMMAR = NO
EVENT_SCOPE_AUTHORITY = ACTIVE_D3_EXECUTION_TURN + MATCHING_REQUEST_CORRELATION
UNKNOWN_TERMINAL_EXPECTATION = FAIL_CLOSED
FREE_TEXT_TO_EVENT_PREDICTION = FORBIDDEN
P3_SEMANTICS_CHANGED = NO
P4_SEMANTICS_CHANGED = NO
CALIBRATION_APPLIED_TO_LIVE = NO
EVENT_PRODUCTION_PREDICTION_CREATION = LIVE
P5_B3_G2_STATUS = COMPLETE
P5_B3_G2_FREEZE = FROZEN
```





### I.25 P5-B3-K · Free-text Explicit Report Candidate / Confirmation

The existing Memory Ops path is not an Explicit Report parser. `_parseMemOps`
extracts only `<mem_create>`, `<mem_update>`, and `<mem_delete>` operations;
`_execMemOps` and its Memory approval flow own their separate write authority.
Calendar `<cal_note>` and workspace `<ws_*>` are model-emitted commands consumed
by their feature executors. They are neither report candidates nor user report
actions. The main single-chat side-effect gate blocks `UNDECIDED`, while the
existing `BYPASSED` and missing-verdict states intentionally preserve legacy
fail-open behavior. Some blog/letter Memory Ops call sites also remain outside
that turn adjudication gate. P5-B3-K does not reuse any of these paths.

The free-text reader is a deterministic, candidate-only fallback. It recognizes
only exact current first-person forms `I like <target>`, `I dislike <target>`,
`我喜欢 <target>`, and `我不喜欢 <target>`, with a target accepted by the shared
`preference-proposition-core.js` grammar. Quoted, hypothetical, historical,
third-person, question-form, uncertain, role-prefixed, and otherwise ambiguous
text produces no candidate. This reader remains available when Middle Brain is
off; it makes no adjudication and cannot create an Explicit Report.

```text
RAW_CHAT_TEXT_IS_EXPLICIT_REPORT = NO
FREE_TEXT_CANDIDATE_IS_AUTHORITY = NO
MODEL_MAY_PROPOSE_REPORT_CANDIDATE = YES
MODEL_MAY_DECLARE_EXPLICITNESS = NO
MODEL_MAY_MINT_EXPLICIT_REPORT = NO
CONFIRMATION_IS_REQUIRED = YES
EXPLICITNESS_AUTHORITY = DEDICATED_STRUCTURED_USER_REPORT_ACTION
CANONICAL_REPORT_PRODUCER = EXISTING_EXPLICIT_PREFERENCE_REPORT_AUTHORITY
SECOND_EXPLICIT_REPORT_VALIDATOR = NO
MIDDLE_BRAIN_OFF_REQUIRES_NO_FAIL_OPEN = YES
EVIDENCE_MATCHER_ENABLED_DEFAULT = false
CALIBRATION_APPLIED_TO_LIVE = NO
```

The candidate's closed public shape is `{ version, stance, targetKey,
sourceMessageRef }`. Candidate ID and scope snapshot live in bounded in-memory
session state, not in the candidate payload. The lifecycle is `pending`,
`confirming`, `confirmed`, `dismissed`, or `expired`; the 15-minute lifetime and
32-candidate cap are session-only. Candidate ID is not request/action ID or
report ID. `sourceMessageRef` is rechecked against the current user message,
character, thread, and unchanged source content before submission. A changed
scope, deleted/changed source message, expiry, or lost session fails closed.

Only the user's `确认记录` button calls Home Node's existing credentialed
`POST /internal/user-reports/preference` action. The client builds the existing
five-key structured envelope (`requestId`, `characterId` selector, `targetKey`,
`stance`, `threadId`); it strips candidate IDs, source text, model/provider data,
and every report/reality/settlement field. The server remains responsible for
character registry binding, conversation derivation, canonical target/stance
validation, report identity, and the sole report mint. RealityEvent, feedback,
P1/P3, and automatic P4 remain the existing downstream chain.

Dismissal, silence, timeout, stale scope, and a missing report action create no
report or RealityEvent. Candidate extraction and confirmation have no Memory,
disclosure, relationship, `cal_note`, `ws_*`, or Auto Memory side effect.

```text
FREE_TEXT_CANDIDATE_EXTRACTION = LIVE
FREE_TEXT_EXPLICIT_REPORT_SUPPORT = CONFIRMATION_GATED
USER_CONFIRMATION_REQUIRED = YES
CONFIRMATION_REUSES_EXISTING_REPORT_AUTHORITY = YES
NO_CONFIRMATION_REPORT_COUNT = 0
DECLINE_REPORT_COUNT = 0
FREE_TEXT_MATCHED_E2E = LIVE
FREE_TEXT_MISSED_E2E = LIVE
MEMORY_WRITE_FROM_CONFIRMATION = 0
MATCHER_DEFAULT_CHANGED = NO
CALIBRATION_APPLIED_TO_LIVE = NO
P5_B3_K_STATUS = COMPLETE
P5_B3_K_FREEZE = FROZEN
```

### I.26 P5-B3-L · Evidence Matcher Production Admission

Production capability and enablement remain separate. The process singleton
accepts only `IB_EVIDENCE_MATCHER_ENABLED=1`; all unset or other values preserve
the frozen default-off policy. An isolated `buildHomeNode` instance may also be
explicitly constructed with `evidenceMatcherEnabled: true`.

The only classification route is the existing
`runtimePredictionSettlement.settlePredictionWithEvidenceMatcher` seam. The
RealityEvent feedback driver selects that same P3 entry only under explicit
opt-in; it has no Matcher call of its own. Default-off feedback remains on the
existing synchronous P3 path. P3 still recomputes P1 gates and owns every
settlement decision.

Mechanical relation checks precede family admission. Token relations, including
structured preference and terminal event facts, do not call the Matcher.
Semantic calls require a statement observation and one of the existing P3
subjective types (`preference`, `latent_state`, `relational`). Only P1 directional
ceilings `ELIGIBLE` or `SUPPORTING` may reach classification; `SUPPORTING` remains
non-decisive in P3. In the current P1 matrix, linguistic evidence for
`latent_state` is `FORBIDDEN`, while linguistic evidence for `relationship` is
`SUPPORTING`; the verified positive path therefore uses `relational`.

Matcher input remains the existing five-key bounded whitelist. Output remains
the closed set `support`, `conflict`, `irrelevant`, `ambiguous`; malformed or
authority-bearing model output becomes `ambiguous`. Provider, model, endpoint,
and credential reference come only from canonical system/character registry
configuration; the request-scoped credential is resolved through the existing
Credential Access and Vault path. Evidence-supplied credential values and
caller-supplied character/turn overrides are ignored.

The P3 attempt uses an opaque per-settlement token. Prediction identity,
character identity, and turn identity come from the canonical P2 record. Frozen
budgets remain 4 calls per settlement attempt, 4 per prediction, and 8 per turn.
The session-only memo remains bounded to 256 entries and a 10 minute TTL, keys
include prediction and observation fingerprints plus matcher/schema versions,
and success/failure memoization follows the existing `SUCCESS_AND_FAILURE`
policy. Calls have an 8 second default timeout capped at 20 seconds and no retry.

This phase does not add a P1 statement producer or turn ordinary chat text into
an Explicit Report. The production admission E2E invokes the existing canonical
`linguistic-evidence` P1 producer and the actual Home Node P3/Matcher assembly.
The existing RealityEvent projector still emits mechanical token observations.
Consequently, a decisive negative remains blocked when the source ceiling is
supporting or Opportunity is unknown; Matcher relation does not create either.
K confirmation, G2 terminal semantics, structured preference semantics, and P4
semantics remain unchanged. Calibration is not applied to live decisions.

```text
MATCHER_PRODUCTION_CAPABILITY = LIVE
EVIDENCE_MATCHER_ENABLED_DEFAULT = false
PROCESS_MATCHER_OPT_IN = IB_EVIDENCE_MATCHER_ENABLED=1
MATCHER_ON_STATEMENT_RELATION = LIVE
ONE_MATCHER_PRODUCTION_CALL_SEAM = YES
MECHANICAL_RELATION_PRECEDES_MATCHER = YES
MATCHER_ROLE = ADVISORY_SEMANTIC_CLASSIFIER_ONLY
MATCHER_MAY_NOT_UPGRADE_SOURCE = VERIFIED
MATCHER_MAY_NOT_UPGRADE_DOMAIN = VERIFIED
MATCHER_MAY_NOT_CREATE_OPPORTUNITY = VERIFIED
MATCHER_MAY_NOT_DECLARE_EXPLICITNESS = VERIFIED
MATCHER_MAY_NOT_CHOOSE_SETTLEMENT = VERIFIED
MATCHER_CREDENTIAL_SOURCE = CANONICAL_REGISTRY_AND_VAULT
EVIDENCE_SUPPLIED_CREDENTIALS = IGNORED
VAULT_DISCIPLINE_PRESERVED = YES
DECISIVE_NEGATIVE_SETTLEMENT = BLOCKED_BY_SOURCE_CEILING_AND_OR_OPPORTUNITY
P3_SETTLEMENT_AUTHORITY = UNCHANGED
P4_SEMANTICS_CHANGED = NO
CALIBRATION_APPLIED_TO_LIVE = NO
P5_B3_L_STATUS = COMPLETE
P5_B3_L_FREEZE = FROZEN
EVIDENCE_MATCHER_PRODUCTION_ADMISSION = LIVE
```

### I.27 P5-B3-L-R1 · Production Linguistic Evidence Observation Producer

The user-authored message fact remains owned by the existing Home Node canonical
`chat-store`. A callback runs only after a new `role=user` row has committed. It
receives a store-sealed bounded fact containing source message ID, stored
character/conversation/thread scope, server `change_log.at`, and at most 400
characters of the stored message content. It excludes metadata, attachments,
voice/image payloads, credentials, prompt, history, and Memory.

The source adapter consumes that sealed fact, verifies its chat-store seal and
registered character binding, asks the existing P1 pairing helper for open
Predictions in the same character/conversation whose window contains the
server commit time, and calls the existing `mintObservation` API. The producer
fixes `producerId=linguistic-evidence` and `targetDomain=user_preference`; caller
and message metadata cannot select either. The existing P1 producer table fixes
`source=LINGUISTIC_EVIDENCE` and
`sourceInstance=runtime.interpretation-evidence`. P1 remains the only
OutcomeObservation builder; no second observation mint or RealityEvent source
is added.

The source message ID is the session fact identity and contains no
`predictionId`. P1 still creates its normal prediction-scoped observation for
each eligible Prediction. Replayed/identical store writes do not emit another
fact; same-ID content updates do not rewrite the original linguistic fact, and
soft deletion does not retroactively erase an already emitted session fact.
Batch migration writes are not live user-message events. The producer uses a
bounded session holder and pending-task set; all projection, P1, Matcher, P3, and
P4 errors are isolated from the already committed chat write.

The first production family is the already-supported `preference` Prediction
with a `user_preference` statement. This uses the existing P1
`LINGUISTIC_EVIDENCE → user_preference` `SUPPORTING` ceiling and does not create
an Explicit Report. `LINGUISTIC_EVIDENCE → latent_state` remains `FORBIDDEN`;
the P1 matrix is unchanged. Matcher remains default-off. When explicitly on,
the producer uses the existing P3 matcher-aware seam. Support remains
non-decisive; conflict cannot become `missed` without the existing directional
authority and Opportunity. K's confirmation path, P4 semantics, and Calibration
Application remain unchanged.

Desktop `communication.js` constructs the message envelope before writing it,
but the observer never consumes that transient object. Home Node's committed row
is the source fact. On the desktop path, `friendId`/message ID/timestamp enter the
existing store envelope; Home Node derives and stores the conversation row and
the callback uses the persisted ID plus server commit time. On the Mobile
Gateway path, the server already derives message ID from `requestId`, binds the
character from its registry, derives conversation, and stamps the message with
its server clock. P1 does not require a turn ID; Matcher budget turn identity
continues to come from P2.

```text
USER_MESSAGE_FACT_AUTHORITY = HOME_NODE_CANONICAL_CHAT_STORE
PRODUCTION_TRIGGER = NEW_CANONICAL_ROLE_USER_ROW_AFTER_COMMIT
CANONICAL_USER_MESSAGE_MAY_PRODUCE = LINGUISTIC_EVIDENCE
LINGUISTIC_EVIDENCE_IDENTITY = SOURCE_MESSAGE_ID_ONLY
LINGUISTIC_EVIDENCE_DOMAIN = user_preference
LINGUISTIC_EVIDENCE_SOURCE = FIXED_BY_P1_PRODUCER_TABLE
LINGUISTIC_EVIDENCE_CEILING = SUPPORTING
RAW_CHAT_TEXT_IS_EXPLICIT_REPORT = NO
LINGUISTIC_EVIDENCE_IS_MEMORY = NO
P1_MATRIX_CHANGED = NO
REALITY_EVENT_LANGUAGE_SOURCE_ADDED = NO
USER_MESSAGE_REPLAY_100X = ONE_LOGICAL_FACT
MESSAGE_UPDATE_REEMITS_FACT = NO
MESSAGE_DELETE_RETRACTS_FACT = NO
CHAT_WRITE_DEPENDS_ON_EVIDENCE_PROJECTION = NO
TEST_MANUAL_LINGUISTIC_EVIDENCE_INSERTS = 0
TEST_MANUAL_OBSERVATION_INSERTS = 0
TEST_MANUAL_FEEDBACK_CALLS = 0
EVIDENCE_MATCHER_ENABLED_DEFAULT = false
K_CONFIRMATION_SEMANTICS_CHANGED = NO
MEMORY_WRITE_FROM_LINGUISTIC_EVIDENCE = 0
CALIBRATION_APPLIED_TO_LIVE = NO
RAW_CHAT_TO_STATEMENT_OBSERVATION = LIVE
P5_B3_L_R1_STATUS = COMPLETE
P5_B3_L_R1_FREEZE = FROZEN
```

### I.28 P5-B3-N · Single-Home Prediction Error v1 Engineering Closure

This append-only entry reconciles the original design-only header above with the
later implementation addenda. The header remains an accurate description of the
original P0 proposal snapshot; I.24-I.28 and
`PREDICTION_ERROR_V1_CLOSURE.md` record current implementation and readiness.

```text
PREDICTION_ERROR_V1_SCOPE = SINGLE_HOME_NODE
SINGLE_HOME_PREDICTION_ERROR_PRODUCTION_CHAIN = CLOSED
PREDICTION_ERROR_V1_SINGLE_HOME = PRODUCTION_READY
PREDICTION_ERROR_V1_STATUS = ENGINEERING_CLOSED
PREDICTION_ERROR_V1_FREEZE = FROZEN
MULTI_HOME_PREDICTION_ERROR = DEFERRED_BY_PLATFORM_DEPENDENCY
MULTI_HOME_NODE_OWNER_BINDING = NOT_LIVE
MULTI_HOME_NODE_FEEDBACK_ROUTING = BLOCKED
CALIBRATION_APPLICATION = INTENTIONALLY_DEFERRED
CALIBRATION_CONFIDENCE = null
CALIBRATION_APPLIED_TO_LIVE = NO
RESTART_RECOVERY = NONE
DURABLE_PREDICTION_REGISTRY = NO_V1
P1_AUTHORITY_MATRIX_CHANGED = NO
EVIDENCE_MATCHER_ENABLED_DEFAULT = false
```

M is a platform dependency, not a v1 readiness gate. Reopen M only after canonical
node identity, runtime session identity, and authenticated routing are live. P4
sample collection remains live; Calibration Application is not part of this
freeze. The implementation, test, durability, and file manifests are in
`PREDICTION_ERROR_V1_CLOSURE.md`.

### I.29 P21-R4-M0 · External Response Participation (append-only)

RUNTIME_BEHAVIOR_EFFECT remains the single sealed attribution owner. M0 adds a
separate, bounded participation record for the closed source
`memory_behavior_modulation`; it is not a BehaviorEffect instance and carries
no posture, prompt text, Memory body, persona, relationship, or settlement data.

```text
EXTERNAL_PARTICIPATION_OWNER = RUNTIME_BEHAVIOR_EFFECT
EXTERNAL_PARTICIPATION_STATES = REGISTERED | CONSUMED | NOT_CONSUMED | STALE
EXTERNAL_PARTICIPATION_ID = RUNTIME_MINTED
EXTERNAL_PARTICIPATION_DURABILITY = SESSION_ONLY
EXTERNAL_PARTICIPATION_PAYLOAD = NONE
```

Only a trusted server-side response consumer can mark a participation
CONSUMED, after it validates the shared response-guidance envelope and includes
the rendered entry in the final prompt passed to the model port. The browser
cannot submit a `consumed` assertion. A registered entry without a verifiable
consumer receipt yields an attribution snapshot of `unknown/partial`; it must
never yield `known-none`. A verified NOT_CONSUMED result does not contaminate
the turn. The snapshot reports external participation separately from
`effects[]`; the R4-F seven-key effect schema and the named
`BEHAVIOR_EFFECT_SUBSYSTEM_ONLY` dependency-trace scope are unchanged.

```text
P3_SETTLEMENT_SEMANTICS_CHANGED = NO
P4_CALIBRATION_SEMANTICS_CHANGED = NO
PREDICTION_INFLUENCED_SYSTEM_SEMANTICS_CHANGED = NO
FALSE_KNOWN_NONE_WITH_UNACCOUNTED_EXTERNAL_INFLUENCE = IMPOSSIBLE
DESKTOP_BROWSER_CONSUMPTION_RECEIPT = NOT_VERIFIABLE
```

The desktop response provider still runs in the browser, so Home Node cannot
verify that a guidance entry it returned was actually included in that
provider request. Desktop registration therefore remains unverified and
fail-closed. Mobile's Home Node execution path can verify its own prompt
assembly. This addendum does not authorize Memory Behavior Modulation; M0 is
partial and R4-M remains blocked.

The earlier “17-key Recall envelope” statements freeze the R4-F/P.E. base
shape and the prohibition on Prediction/Expectation fields. They do not reject
the later source-owned optional `association`, `reinterpretation`, and
`selfNarrative` projections. The 17→18 assertion was stale; the regression now
checks the frozen base keys plus that explicit optional allowlist.
The shared guidance object is nested under the existing context payload and
uses `r4f_behavior_effect`; it adds no top-level Recall key and no
Prediction/Expectation-named field or source token.

### I.30 P21-R4-M0-R2 · External influence calibration admission gap (audit)

This is an audit finding, not a P3/P4 semantic change. The isolated
`test_r4m_desktop_admission.js` constructs a valid event Prediction whose
creation snapshot is `known-none`, then registers an external
`memory_behavior_modulation` participation without a trusted Desktop receipt.
The attribution owner reports `unknown/partial` for a later outcome. When that
UNKNOWN, non-decisive outcome is combined with an earlier clean decisive
support observation, the current P3 result is `matched` and
`calibrationCounted=true`; the current calibration driver forwards it to P4.

```text
UNVERIFIED_EXTERNAL_INFLUENCE_MUST_NOT_REACH_P4_AS_CLEAN = REQUIRED
CURRENT_P3_P4_PATH_ENFORCES_THIS_FOR_ALL_PREDICTION_TYPES = NO
P3_CALIBRATION_COUNTED_SEMANTICS_CHANGED_BY_R2 = NO
P4_CALIBRATION_INGEST_SEMANTICS_CHANGED_BY_R2 = NO
P21_R4_M0_R2_STATUS = BLOCKED_BY_CALIBRATION_FAIL_CLOSED_GAP
```

The guard intentionally remains red until an authorized Prediction Error
semantics phase resolves the gap. R2 must not reinterpret UNKNOWN as
`known-none`, add a Desktop-only calibration bypass, or claim clean-sample
exclusion while this counterexample remains reachable.

### I.31 P5-B3-J-R3 · Outcome-Time Calibration Evidence Basis

P3 now derives calibration cleanliness from a deterministic basis of the
decisive P1 OutcomeObservations that can support the final settlement state.
P1 already seals outcome-time attribution in its effective
`interventionContext.contaminationClass`; P3 consumes that fact through its
existing authority gate and does not query the attribution owner again.

```text
PREDICTION_CREATION_ATTRIBUTION_IS_SUFFICIENT_FOR_CALIBRATION = NO
P3_SETTLEMENT_STATE_SEMANTICS_CHANGED = NO
P3_CALIBRATION_ELIGIBILITY_USES_OUTCOME_DECISIVE_BASIS = YES
P4_REJUDGMENT = NO
P4_DRIVER_AND_LEDGER_SEMANTICS_CHANGED = NO
```

For `matched`, a clean decisive support basis must meet P3's support threshold
and the existing `conflictAll === 0` condition. A later UNKNOWN supporting
observation is not in that basis and does not automatically invalidate an
independent clean support. For `missed`, the basis consists of decisive
conflicts already admitted by P1's directional and opportunity gates; at least
one required conflict observation must be outcome-time clean. `mixed`,
`pending`, `expired_unobserved`, `unresolvable`, and `superseded` remain
ineligible.

Outcome-time evidence is clean only when the sealed P1 observation has
`contaminationClass === 'NONE'`, no behavior effect in force, and no
`predictionInfluencedSystem === true`. UNKNOWN, partial, POSSIBLE, LIKELY, or
DIRECT required evidence keeps calibration ineligible while the P3 settlement
state is preserved. The existing Prediction-creation self-influence veto also
remains in force; a creation-time `known-none` never proves that later outcome
evidence was clean.

The sealed P3 SettlementRecord carries a bounded `calibrationEvidenceBasis`
with relation, required count, decisive and clean observation IDs, per-basis
contamination/opportunity facts, and a closed exclusion reason. P4 continues to
consume only the sealed P3 `calibrationCounted` bit.

```text
OUTCOME_TIME_CALIBRATION_ATTRIBUTION = LIVE
CALIBRATION_EVIDENCE_BASIS = DETERMINISTIC
UNVERIFIED_EXTERNAL_INFLUENCE_CLEAN_CALIBRATION = IMPOSSIBLE_FOR_REQUIRED_DECISIVE_EVIDENCE
SETTLEMENT_MAY_COMPLETE_WITHOUT_CALIBRATION = YES
P5_B3_J_R3_STATUS = COMPLETE
P5_B3_J_R3_FREEZE = FROZEN
```

Regression coverage is in `tests/test_prediction_settlement_calibration_basis.js`
and the updated `tests/test_r4m_desktop_admission.js`. This corrective phase
does not complete P21-R4-M0-R2 or declare R4-M ready; those gates require a
separate closure reconciliation.

### I.32 P21-R4-M0-R2 · Fail-Closed Desktop Admission Reconciliation

P5-B3-J-R3 supplies the missing P3 basis authority required by R2. Desktop
provider dispatch and consumption remain unverifiable; R2 does not add a
Browser receipt or change that fact. Instead, an external influence without a
trusted receipt remains `unknown/partial`, and P3 excludes any required
outcome-time decisive evidence that is not clean before setting
`calibrationCounted`.

```text
OPTION_B = ACCEPTED
R4_M_DESKTOP_ADMISSION_POLICY = FAIL_CLOSED_UNVERIFIED_ALLOWED
DESKTOP_CONSUMPTION_RUNTIME_VERIFIABLE = NO
DESKTOP_ATTRIBUTION_FAIL_CLOSED = LIVE
MOBILE_CONSUMPTION_RUNTIME_VERIFIABLE = YES
FALSE_KNOWN_NONE_WITH_UNVERIFIED_EXTERNAL_INFLUENCE = IMPOSSIBLE
UNVERIFIED_EXTERNAL_INFLUENCE_CLEAN_CALIBRATION = IMPOSSIBLE_FOR_REQUIRED_DECISIVE_EVIDENCE
PREDICTION_SETTLEMENT_REMAINS_LIVE = YES
BEHAVIOR_ATTRIBUTION_SINGLE_OWNER = PRESERVED
PREDICTION_ERROR_SEMANTICS_CHANGED_BY_R2 = NO
PREDICTION_ERROR_CALIBRATION_ELIGIBILITY_CORRECTIVE = P5-B3-J-R3
MEMORY_BEHAVIOR_MODULATION_IMPLEMENTED = NO
TRUSTED_DESKTOP_EXECUTION_CONVERGENCE = DEFERRED_PLATFORM_WORK
P21_R4_M0_R2_STATUS = COMPLETE
P21_R4_M0_STATUS = COMPLETE
P21_R4_M0_FREEZE = FROZEN
R4_M_REENTRY = ALLOWED
```

The required-decisive-evidence qualifier is intentional: a clean decisive
basis remains usable when a later UNKNOWN supporting/irrelevant observation is
outside that basis. This reconciliation does not make Desktop runtime
consumption verifiable or complete Memory Behavior Modulation.

