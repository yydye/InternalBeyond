# P25-2 · Moments Autonomy Closure / Freeze

状态：**LOGICALLY FROZEN**（Closure 阶段；只枚举 + 冻结 + 证明，不新增功能、不重构、不清债）。
Commit 状态：**DEFERRED BY OWNERSHIP**（见 §30）。

阶段构成：

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P25-1 | Autonomy Core Foundation（纯裁决层） | PASS |
| P25-2A | Moments Autonomy Adapter Foundation | PASS |
| P25-2B | Moments Semantic Recommendation（v2 契约） | PASS WITH NOTES |
| P25-2C | Desktop Scheduler / Trigger Migration | PASS WITH NOTES |
| P25-2D | Companion Runtime Convergence | PASS WITH NOTES |
| P25-2 | Closure / Freeze（本文件） | PASS |

---

## 1. Scope

Closure 只做四件事：**枚举**生产创建路径、**冻结**不变量、**证明**两个 runtime 收敛、
**分类**遗留债。允许的写入仅限：Closure 文档、Closure 测试、必要的守卫修正与测试注册。
不新增 Moments 功能、不动 scheduler / semantic / Autonomy Core、无 DB migration、无新 store / queue。

## 2. Frozen architecture

```
Desktop Trigger ─┐
                 ├→ Candidate Seed → Semantic Recommendation → Candidate Finalization
Companion Trigger┘        → Autonomy Adapter → Autonomy Core
                             ├ DENY  → stop
                             ├ DEFER → stop
                             └ ALLOW → Image → Executor → createMoment
                                          → _momentsWriteCanonical → canonical/mirror
```

唯一允许绕过 Autonomy 的创建路径：**explicit user manual create**。

## 3. Primary invariant（MOMENTS_AUTONOMOUS_CREATE_INVARIANT）

> 任何在**没有显式用户手动创建动作**的情况下创建 Moment 的生产路径，
> 必须在 `image generation` / `createMoment` / `canonical write` **之前**经过 `runMomentAutonomy`。

禁止的直达边（全部已由测试守卫）：`scheduler → writer`、`model → writer`、
`semantic → writer`、`companion → writer`、`event ingest → writer`、`image generator → writer`。

## 4. Manual exception

`composer` / 社交网络页的手动动作 → `createMoment(source:'manual', authorType:'user')`：
autonomy 调用 0、semantic 调用 0、companion 调用 0（CL31 实测）。
「让 TA 发一条」**不属于**手动创建 —— 它是 `source:'character'` 的 autonomous 动作，必须过 Autonomy（CL32）。

## 5. Desktop runtime

`_activeTick → _momentsTick → _momentsLocalTick`（只在 companion 离线/让出时执行）
→ `buildMomentCandidateSeed`（`schedule:<nextAt 槽位>`）
→ `evaluateRoleMomentSemantic`（一次模型调用）→ `finalizeMomentCandidate`
→ `runMomentAutonomy` → ALLOW only → 图片 → `_momentsWriteApprovedMoment` → `createMoment`。
`generateRoleMoment` 是 LEGACY WRAPPER（内部只走同一管线，无直接写入路径）。

## 6. Companion runtime

`active/moments.js momentsTick → executeMomentSchedule`（频率 / recurrence / backoff / claim /
hibernate 全部保留）→ **与桌面同一份** semantic core 的 prompt + parser → 候选事件
（`recommendation` / `reason_code` / `topic_key` / `topic_fingerprint` / `draft` / `trigger_ref`）
→ 浏览器 `_momentsIngestEvent` → `finalizeMomentCandidate` → `runMomentAutonomy`
→ ALLOW only → 图片 → `_momentsWriteCompanionMoment` → `createMoment`。
companion 侧 `createMoment` / `_momentsWriteCanonical` / `dbPut` 引用 = **0**（CL6）。

## 7. Shared semantic contract

`active/moments.js` 与浏览器都 `require`/加载 `assets/js/moments-semantic-core.js`（唯一实现）：
推荐闭集、reasonCode 闭集、topic 归一、topicFingerprint、禁 CoT 字段、draft 契约、
prompt schema、correction 提示。同一输入喂两端 parser，`ok`/`error`/`stage`/归一结果逐项相等
（`test_moments_companion_convergence.js` CC5–CC8）。

## 8. Recommendation vs permission

模型只能给 `post` / `skip`；`post` ≠ ALLOW、`skip` 也不是"模型行使 DENY"。
真正的 decision（ALLOW / DENY / DEFER）只属于 Autonomy Core。adapter **永远**显式提供
`ctx.decide` 并标记 `explicitPolicy = true`，绝不依赖 Core 的 `default-allow`。

## 9. Candidate identity

`Candidate Seed{actorId, source, triggerRef}` + `Semantic{topicFingerprint}`
→ `finalizeMomentCandidate` → `candidateId = 'mca_' + stableToken(actorId|triggerRef|topicFingerprint)`
→ `Moment id = 'mom_' + stableToken(candidateId)`。
身份**不使用**：`Date.now`、`Math.random`、事件到达时间、完整草案正文（CL23/CL24）。

## 10. triggerRef semantics

- Desktop：`schedule:<本次调度槽位>`（槽位 = 既有 `nextAt`；手动触发用 `character:<lastPostAt>:<slot>`）；
- Companion：`companion:<recurrence 槽位>`（槽位 = 生成前捕获的 `due`）；
- 同一逻辑 slot 重放 ⇒ 同一 triggerRef ⇒ 同一 candidate ⇒ 同一 Moment id（CL19–CL22）。

## 11. Replay / idempotency

同一事件重放最多一行；同一话题换措辞（同 trigger）收敛到同一 candidate / 同一 Moment id；
retry 不 double-post；canonical 承载下由 `requestId` + 内容等价（`replayed` / `skipped`）保证。

## 12. Autonomy policy

Moments 的 policy 全部在 adapter/policy seam：prefs（`ib_moments_prefs_v1`）、cooldown
（`MOMENT_MIN_INTERVAL`）、duplicate（跨会话精确内容 + Core runtime window）、
content safety（secret 探测 + sanitizer 接缝）、可选加严（`extraPolicy`）。
Core 保持 business agnostic（byte-identical）。

## 13. DENY

不写 Moment、不生图、不写 placeholder、不 fake social event；**不**转成 execution failure
（`ok:true, published:false, decision:'deny'`）；只记 `post_blocked` 观测并 ack 事件。

## 14. DEFER

不写 Moment、不生图、不排队、不持久化候选、不 `setTimeout` 重试；
未来的 scheduler recurrence 自然产生新 candidate。

## 15. ALLOW

只有 ALLOW 才允许：图片生成 → executor → `createMoment` → canonical write。
executor 失败仍是 **ALLOW + execution failure（`ok:false`）**，绝不改写成 DENY。

## 16. Image ordering

`semantic → autonomy → ALLOW → image`（桌面 + companion 都成立）：
skip / DENY / DEFER 的 image router 调用数 = 0；ALLOW 才可能调用（CL14/CL16/CL18）。

## 17. Executor boundary

executor（`_momentsWriteApprovedMoment` / `_momentsWriteCompanionMoment`）只做
"图片（可选）+ createMoment"；不重新判断 recommendation / reasonCode / prefs / cooldown /
duplicate / policy，也不调模型（CL7/CL38 的源码切片断言）。

## 18. Canonical writer authority

唯一创建权威：`createMoment`（1 处定义、1 处 `await _momentsWriteCanonical(`、1 处 `hn.put(m,`）。
canonical 承载下 autonomous create 不触发 `moments-write-closed`（CL34）；
直接 `dbPut('moments')` 仍被守卫拒绝（既有行为，未改）。

## 19. Scheduler ownership

companion 在线 → 桌面让出（只拉事件 + 同步）；companion 离线 → 桌面 scheduler 接管；
online/offline 切换不得同 slot double-post（CL35–CL37）。Closure **未改** scheduler。

## 20. Prefs authority

唯一 prefs 权威 = `ib_moments_prefs_v1`（浏览器侧）。companion 快照里的
`prefs.enabled` + `schedule.enabled(=autoPublish)` 只用于"避免无用模型调用"的早退，
**不是**权限来源；不存在 companion 第二套 prefs（CL38）。

## 21. History authority

跨会话 duplicate 来自 canonical Moments 历史（`readRecentOwnMoments`）；
runtime duplicate 允许保持 runtime-only；**禁止** companion duplicate DB（CL39）。

## 22. Provider / secret boundary

candidate / event / action context 只含业务字段；不含 apiKey / Authorization / credential /
endpoint secret / raw provider config / system prompt / CoT（CL29/CL30）。
provider core 未改。

## 23. No-CoT

语义输出禁止 `thinking` / `reasoning` / `analysis` / `rationale` / `explanation` /
`chain_of_thought` / `cot` / `scratchpad` / `steps`；它们不进 event、action context、
Moment、trace、telemetry（CL28 + A/B/D 各套件的具体断言）。两端共用同一份禁字段表。

## 24. Legacy wrapper

`generateRoleMoment` 保留并标记 **LEGACY WRAPPER**：生产调用方为
desktop scheduler 与「让 TA 发一条」；已证明它不能绕过 Autonomy。Closure 不删除它。

## 25. v1 compatibility

2A 的 v1 reasonCode 占位词表继续存在，标记 **LEGACY COMPATIBILITY / NOT NEW AUTHORITY**；
退役条件 = 证明没有生产调用方依赖，留给后续清理阶段。

## 26. Mutation authority debt（OUT OF P25-2 CREATE CONTRACT）

`likes` / `comments` / `delete comment` / `delete Moment` / companion reply-comment
仍是直接 `dbPut` / `dbDelete`。它们**不是** autonomous create bypass，
已在 Closure 测试里单独归类（CL48），建议未来独立阶段：Moments Mutation Authority Closure。

## 27. Companion accounting note（NON-BLOCKING）

companion 在候选产生时推进自己的 `nextAt / lastPostAt / declineStreak / recent_moments /
lastMomentId`；若浏览器随后 DENY/DEFER，这份记账会短暂偏乐观，下一次快照同步自愈。
它**不破坏** AUTONOMOUS_CREATE_INVARIANT（写入与否仍由浏览器裁决），因此记为非阻塞 note。

## 28. Version-skew note（NON-BLOCKING）

事件里的 `moment_id` 是 legacy/temporary 兼容身份；canonical id 由 candidate 派生。
同一版本（新 companion + 新浏览器）不会双发（CL19/CL20）。
跨版本（旧浏览器 + 新 companion 或反之）属 rolling-version 兼容区间，记为 note。

## 29. Tests

| 套件 | 覆盖 | 结果 |
| --- | --- | --- |
| `test_moments_autonomy_closure.js` | CL1–CL50（枚举 + 冻结 + 收敛） | 50 / 0 |
| `test_moments_companion_convergence.js` | CC1–CC50 | 50 / 0 |
| `test_moments_scheduler_migration.js` | SC1–SC35 + 子项 | 38 / 0 |
| `test_moments_semantic_recommendation.js` | MS1–MS50 | 84 / 0 |
| `test_moments_autonomy.js` | MA1–MA50 + CW1–CW10 | 78 / 0 |
| `test_autonomy_core.js` | A1–A18 + 守卫 | 41 / 0 |
| `test_moments_companion.js` | companion 域 | 25 / 0 |
| `test_moments_authority.js` / `test_moments_http.js` | canonical store / HTTP | 78 / 0；31 / 0 |
| 浏览器：smoke / user smoke / phase2 / phase3 / phase4 / socialnet / image router / browser authority / runtime convergence | 真实页面 | 全部通过 |

## 30. Known limitations / 冻结边界

- 两个 runtime 的 ledger 语义不同（桌面 adapter 账本按调用新建；companion 只有 schedule 记账）；
- 事件 `moment_id` 与 canonical id 在版本偏斜下可能不同（note）；
- mutation authority debt 未清（out of contract）；
- Memory authority / Middle Brain / disclosureFacts / comment autonomy / Image Router 并发
  都不属于 P25-2（见 §32）。

## 31. Frozen contracts（不可在后续阶段悄悄改的）

FROZEN：

1. autonomous create requires Autonomy（桌面 + companion）
2. manual create 是唯一 bypass
3. semantic v2 契约（recommendation / reasonCode / topicKey / draft）
4. recommendation ≠ permission；只有 Autonomy 产出 ALLOW/DENY/DEFER
5. Desktop / Companion 共用同一份 semantic core
6. candidate identity（stableToken 派生；无时钟、无随机、无到达时间、无正文当身份）
7. triggerRef 语义（desktop `schedule:<slot>`；companion `companion:<slot>`）
8. ALLOW-only execution；DENY/DEFER 零写零图
9. image-after-ALLOW
10. canonical writer authority（唯一 writer，唯一落盘通道）
11. 唯一 prefs 权威（`ib_moments_prefs_v1`）
12. canonical history authority（跨会话 duplicate）
13. no-CoT（两端同一份禁字段表）
14. secret boundary（candidate / event / action context 只含业务字段）

## 32. Deferred / NOT FROZEN（明确推迟）

mutation authority（likes / comments / delete）· disclosureFacts · Memory context ·
Middle Brain · comment autonomy · Image Router 并发策略 · companion bookkeeping 精化 ·
`generateRoleMoment` 退役 · v1 reasonCode 词表退役 · 跨版本（rolling）兼容策略。

## 33. Commit readiness（只读结论）

P25-2 的**逻辑**边界清晰（Closure 测试可枚举、可断言），但工作区里它与其它批次交织：

- `tests/test-all.js` 同一文件里含 P22 / P23 / P24 / Economy / P25 的登记 hunks；
- `InternalBeyond.html` 含 P23 / P24 / M1-C 的脚本与注释 hunks；
- 其余 P25-2 写入集（moments.js / moments-semantic-core.js / moments-autonomy.js /
  active/moments.js / services/active-message-service.js / moments 系列测试 / docs）本身
  只承载 P25-2 改动。

按 Closure 规则不强行拆 hunk ⇒ 结论：**COMMIT DEFERRED BY OWNERSHIP**。
