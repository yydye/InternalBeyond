# P25-3A · Unified Agent Orchestration Foundation

状态：**FOUNDATION ONLY**。契约已建立并通过独立测试；**生产默认行为不变**：
Orchestrator 未被接入 `communication.js` / group runtime / active scheduler / Middle Brain /
Diary / Moments scheduler / Economy runtime（测试断言生产文件零引用）。

实现位置：

- `assets/js/agent-capability-registry.js`（registry：只回答"IB 有什么能力"）
- `assets/js/agent-orchestration-core.js`（编排契约：request / plan / routing / execution / reflect）
- `assets/js/agent-orchestration-moments-adapter.js`（Moments reference adapter）
- 测试：`tests/test_agent_capability_registry.js`（R1–R12）、`tests/test_agent_orchestration_core.js`（O1–O25）、
  `tests/test_agent_orchestration_moments_adapter.js`（M1–M18）
- 能力清册：`docs/P25-3-CAPABILITY-INVENTORY.md`

---

## 1. Scope

建立**统一编排契约**：Intent → Observe → Decide/Plan → Capability Selection →
Authority/Policy Boundary → Execute → Verify → Reflect。
本阶段**不**让 Agent 立刻能调用 IB 的所有功能；不迁移任何生产触发。

## 2. Goals

- 让"能力"成为可枚举、可审计的**声明**（descriptor），而不是散落在各模块里的 `if (…)`；
- 把"计划"与"许可"彻底分开（Plan != Permission）；
- 让权限**继续**留在各 domain（不造 Mega Router / Super Permission Engine）；
- 给未来的 P25-3B+ 提供一个稳定的挂点：新增能力 = 新增 descriptor + 既有 authority/executor 绑定。

## 3. Non-goals

不接 Diary / Active Message / Economy / Cinema / Co-read / Role Letter / Memory / Middle Brain /
Group Runtime；不改 P23 / P24 / provider core；无 DB migration、无新持久队列、无新 scheduler、
无新后台进程。

## 4. Existing capability audit

见 `docs/P25-3-CAPABILITY-INVENTORY.md`（每项含入口 / 触发者 / 模型调用 / authority / policy /
executor / writer / scheduler / runtime / Memory / MB / kind）。

## 5. Capability taxonomy

`kind`: `read` / `write` / `action`（最小充分分类）。
`authorityType`: `autonomy` / `mutation` / `domain` / `manual` / `read-only`（**只声明**）。
`sideEffect`: `none` / `local` / `external`（当前无 `external`）。

## 6. Registry

`createCapabilityRegistry()` → `register / get / has / list / size / snapshot / validate`。

- 只保存 metadata + binding key；**不执行、不裁决、不路由**；
- 重复 id 拒绝；descriptor 深冻结（不可变）；枚举按 id 稳定排序；
- 描述符必须可序列化：函数 / 凭据键名 / 凭据值一律拒绝（R7/R8）。

## 7. Descriptor

```js
{ id:'moment.post', domain:'moment', kind:'write', description:'…',
  sideEffect:'local', authorityType:'autonomy', binding:'moments.autonomy.pipeline',
  availability:'available'|'unavailable'|'degraded', notes? }
```

约束：`id = domain.action(.sub)`；`read` 只能 `read-only` 且 `sideEffect:'none'`；
`write/action` 必须有真实 authority（不得 `read-only`）；未知字段一律拒绝。

## 8. Request

`{requestId, actorId, source, intent, context?, conversationId?, groupTurnId?}`：
actorId 必须是 canonical id（形状校验）；source 闭集（user/schedule/character/group_runtime/system）；
**完整聊天历史不进 request**（`messages` / `history` 是 forbidden context 键）；
context 有键数与数组长度上限；凭据/CoT 一律拒绝。

## 9. Intent

`{goal, constraints?, preferredCapabilities?}`：goal 是短目标（非自由命令）；
`preferredCapabilities` 只是 hint —— 不绕过 registry，也不绕过 authority。

## 10. Observation

Observation Bundle `{actor, conversation?, activity?, capabilities, domainFacts?}`：
只放 plan 所需 facts；Memory / 聊天 / Diary / 朋友圈的**全量**都不进来（有键数与长度上限）。
本阶段不真正接 Memory。

## 11. Plan

`{planId, actorId, steps:[{stepId, capabilityId, input, dependsOn?, reasonCode?}]}`：
capability 必须已注册；stepId 唯一；dependsOn 允许前向引用、必须指向本 plan 内的步骤；
环检测独立于其它字段错误；step ≤ 32；reasonCode 只允许短闭集形态（`^[a-z][a-z0-9_-]{0,40}$`）。

## 12. Plan != Permission

冻结：plan 里出现 `moment.post` **不代表**允许发布。执行链必须是
`Plan → Capability Resolution → Domain Authority → ALLOW → Executor`；
测试 O6 用"合法 plan + authority deny"证明 executor 调用次数为 0。

## 13. Authority routing

`routeStepAuthority(descriptor, step)` 只回答"问谁"，不回答"允许不允许"：
`moment.post → autonomy`、`moment.like/comment/reply/comment.delete/delete → mutation`、
未来 `economy.* → domain`。写能力缺 authority ⇒ `side-effect-capability-needs-authority`（fail closed）。
**禁止** Unified Super Permission Engine。

## 14. Execution

`runAgentPlan(plan, registry, deps)`：deps 全部注入
（`resolveExecutor` / `invokeAuthority` / `isCancelled` / `idempotencyKeyFor`）。
每个 step 的顺序：取消检查 → 能力存在 → 依赖满足 → authority routing（await 域内裁决）→ executor。
返回 `{ok, planId, actorId, status, steps:[{ok,status,capabilityId,stepId,errorCode,output,idempotencyKey}], reflection}`。

## 15. Status semantics

闭集：`completed` / `denied` / `deferred` / `failed` / `unavailable`。
`denied` = authority 不允许（executor 0 次）；`failed` = authority 允许但 executor 失败；
`deferred` = authority 推迟；`unavailable` = 能力/executor/authority 缺失。二者绝不互相冒充。

## 16. Verify

`verifyStepResult(result, verifier)`：只有 `completed` 才可能 verified；
本阶段**只定义 contract**，不给任何模块实现 verifier（未来 `moment.post` 必须验证
canonical Moment 真的存在，而不是只信 executor 返回 ok）。

## 17. Reflect

结构化 outcome summary：`{outcome:'success'|'partial'|'failed', completedSteps, deniedSteps,
failedSteps, deferredSteps, unavailableSteps, reasonCodes}`。无隐藏推理文本。

## 18. No-CoT

Request / Observation / Plan / Execution output / Trace / Reflection 一律禁止
`thinking` / `analysis` / `rationale` / `scratchpad` / `chain_of_thought` / `internal_reasoning` / `cot`；
允许 `reasonCode` / `summary` / `outcome`。出现禁字段 ⇒ 契约错误（O21）。

## 19. Secret boundary

所有层禁止 apiKey / Authorization / credential / secret / provider token / raw provider config；
registry descriptor 同样不得携带。输出清洗会剥离凭据形态与禁键（O22）。

## 20. Availability

descriptor 允许声明 `available` / `unavailable` / `degraded`；
域适配器可以在运行时决定"当前能不能调用"。**不做** health monitoring system。

## 21. Side effects

每个 capability 必须声明 `sideEffect`：`read` 恒 `none`；Moment create/like/comment 是 `local`；
`external` 保留给未来真实外部动作（Economy 当前没有真实支付，不声明 external）。

## 22. Idempotency

执行请求携带 `idempotencyKey`，Orchestrator **只透传**稳定 key；
业务幂等仍由 domain 持有（Moment：candidate identity；Economy：既有 idempotency contract）。

## 23. Cancellation

每个 step 执行前检查 `isCancelled()`；取消后**后续 step 不执行**（记 `denied/cancelled`）；
已完成的 side effect 保留（不假装没发生，也不做通用事务回滚）。

## 24. Dependencies

支持简单 DAG/顺序：拓扑序执行（同层按声明顺序），无环（环 ⇒ `dependency-cycle`）；
依赖未 completed ⇒ 本步不执行（`denied/dependency-failed`）。

## 25. Retry boundary

Orchestrator **不 retry side-effect capability**（避免 double post / double comment / double purchase）；
重试永远由 domain 决定（O18 证明失败后 executor 只被调用一次）。

## 26. Moments reference adapter

6 个 descriptor（post + like/comment/reply/comment.delete/delete）：
`moment.post → authorityType 'autonomy'`（真实 `runMomentAutonomy`）、
其余 → `'mutation'`（真实 `runMomentMutation`）。executor 一律转交给**既有** domain 入口
（`createMoment` / `likeMoment` / `addMomentComment` / `deleteMomentComment` / `deleteMoment`），
adapter 自身零 `dbPut` / 零 `createMoment` 直调 / 零模型 / 零 DOM。

## 27. Frozen boundaries

`autonomy-core.js`、P23 五核心、`group-runtime-core.js` byte-identical；`DB_VER` 与
Moments schema 未变；P25-2 create invariant 与 P25-2.5 mutation invariant 未变
（M17/M18 断言两个阶段的守卫与 hash 仍成立）。

## 28. Deferred integration（P25-3B+）

Diary / Active Message / Role Letters / Activity / Co-read / Cinema / Memory / Economy 的
descriptor 登记与生产接线；真正的 planner（模型产 plan）；verifier 实现；
availability 的运行时接线。**本阶段一个都没做**。

## 29. Tests

R1–R12（registry）、O1–O25（core）、M1–M18（Moments adapter），全绿；
与 P25-2 Closure / P25-2.5 / Moments Autonomy / Moments smoke 一起复跑。

## 30. Known limitations

- `runAgentPlan` 的权威预检与域内执行会**各裁决一次**（同一权威、同一输入 ⇒ 同一结论；
  不构成第二权限），因为 mutation 执行入口本身已内置 authority（P25-2.5 冻结）；
- Plan 目前由调用方给出（本阶段不产 plan：没有模型 planner）；
- `verify` 只有 contract，没有 verifier 实现；
- registry 里的 `binding` 是字符串引用（人类可读约定），运行期解析由各自 adapter 负责；
- Orchestrator 未接入生产（这是本阶段的**要求**，不是缺陷）。
