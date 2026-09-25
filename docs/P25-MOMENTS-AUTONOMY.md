# P25 Moments Autonomy — Adapter（2A）· Semantic Recommendation（2B）

状态：**2A adapter foundation + 2B 语义推荐契约已完成（capability only）**。
生产触发**尚未切换**：scheduler 仍走旧路径（`generateRoleMoment → createMoment`，
其中 `generateRoleMoment` 现在是 LEGACY UNTIL P25-2C 的兼容桥），
真正切换触发是 P25-2C。

实现位置：

- `assets/js/moments-autonomy.js`（UMD 纯 adapter；浏览器暴露 `window.IBMomentsAutonomy`，Node 侧 `require`）
- `assets/js/moments-semantic-core.js`（UMD 纯语义契约：唯一 parser + topic fingerprint + legacy 投影）
- `assets/js/moments.js`（唯一创建点收敛为一条落盘通道：`_momentsWriteCanonical`；
  `evaluateRoleMomentSemantic()` = 真实模型接缝；`generateRoleMoment()` = 兼容桥）
- 测试：`tests/test_moments_autonomy.js`（2A · MA1–MA50 + CW1–CW10）、
  `tests/test_moments_semantic_recommendation.js`（2B · MS1–MS50；纯 Node，含真实 `moments.js` 沙箱）

---

## 1. Architecture

```
Trigger → Candidate Builder → Recommendation → Moments Autonomy Adapter
        → P25 Autonomy Core（唯一裁决权威）
        → Executor Bridge → Moments Creation Authority（createMoment）
        → Persistence Authority（Home Node canonical / IndexedDB mirror）
```

本阶段**不接 Trigger**（2C）、**不接模型推荐**（2B）。实际可跑的最小闭环：

```
buildMomentCandidate → 注入的 recommendation → runMomentAutonomy
  → IBAutonomyCore.runAutonomyAction → executeMomentPost → createMoment
```

## 2. Candidate contract

```js
{
  candidateId,          // 'mca_' + stableToken(actorId|triggerRef|topicFingerprint)
  actorId,              // = apiConfigs.id（与 Moment.roleId 同一 identity domain）
  actionType: 'moment.post',
  source,               // 'schedule' | 'character'（'user' 显式拒绝）
  triggerRef,           // 触发事件身份（如 'tick:2026-09-19T10:00Z'）
  topicFingerprint,     // 语义/话题身份，**不是**草稿全文
  context               // 可选 plain object；命中凭据形态 ⇒ 拒绝
}
```

契约要点：

- `candidateId` **确定性且无时钟**：同一个 `actorId|triggerRef|topicFingerprint` 永远得到同一个 id；
  不同 actor / trigger / topic ⇒ 不同 id。实现复用 `chat-core.stableToken`（与群聊 `turnId`、
  日记同一哈希原语）；核心缺席 ⇒ fail closed（绝不退回 `Date.now` + `Math.random`）。
- `topicFingerprint` 必须是话题身份：`topicFingerprint === 草稿全文`（或完整包含草稿）⇒ 拒绝
  （错误词 `fingerprint-looks-like-draft`）；长度上限 120，不接受控制字符与首尾空白。
- `source:'user'` ⇒ `unsupported-source`。用户手动发帖**不走** autonomy（见 §9）。

## 3. Recommendation contract（本阶段零模型）

调用方/测试注入：

```js
{ recommendation: 'post' | 'skip', reasonCode, topicFingerprint, draft? }
```

- 闭集 `post` / `skip`；`reasonCode` 闭集且与推荐**方向一致**：
  - post：`scheduled-window` / `character-impulse` / `recent-event` / `social-response` / `mood-shift`
  - skip：`no-material` / `duplicate-topic` / `recently-active` / `quiet-hours` / `already-covered` / `low-value`
- `topicFingerprint` 必填且必须等于候选的指纹（`fingerprint-mismatch` ⇒ 拒绝）。
- **不接受自由文本理由**：出现 `thinking` / `cot` / `rationale` / `reason` / `analysis` / `explanation`
  任一字段 ⇒ `free-text-reason-forbidden`（不记录 CoT，不展示给用户）。
- missing / malformed / 未知词 ⇒ 失败对象（下游一律 **DENY**），**绝不 fallback ALLOW**。

`recommendation:'post'` ≠ 允许发布：它只是 policy 的输入之一。

## 4. Policy contract（fail closed）

adapter 的裁决顺序（第一个不通过者决定 adapter 级 `reason`）：

```
candidate 合法 → recommendation 合法 → prefs 可读 → enabled === true → autoPublish === true
→ recommendation !== 'skip' → content 合法 → now 已注入 → post shape 合法
→ cooldown 事实可读 → history 事实可读 → 无跨会话重复内容
```

全部通过才把 `{decision:'allow'}` 交给 Core；否则 `{decision:'deny'}`（DEFER 见 §8）。

- prefs 读不到 / 读失败 ⇒ `prefs-unavailable`；字段畸形（非布尔 / 非法 frequency）⇒ `prefs-malformed`。
- 时间必须由调用方注入（`deps.now`）：缺失 ⇒ `time-not-injected`（没有时间就无法做重复/冷却判定）。
- 注入的读口或清洗钩子**抛错** ⇒ `policy-failure`（绝不"读不到就当没有"）。

## 5. Settings authority

复用 canonical key `ib_moments_prefs_v1`（**没有第二套开关**），只读三项：
`enabled` / `autoPublish` / `frequency`。

- 生产解析走 `IB.moments._momentsPrefs`（唯一偏好真源）；
- 测试/集成用 `deps.readPrefs` 或 `deps.prefs` 注入（纯 contract 不绑 DOM / 不碰 localStorage）；
- adapter 不写任何设置。

## 6. Action mapping & Autonomy Core boundary

```
candidate → { actionType:'moment.post', actorId, source, fingerprint: topicFingerprint,
              context:{ candidateId, momentId, topicFingerprint, triggerRef, content,
                        visibility, visibleRoleIds, motive, images, presentation,
                        recommendation, reasonCode } }
```

- context 里**不放** provider 配置 / API key / raw cfg（Core 也会独立拦 `secret-in-action`）。
- adapter **永远显式提供 `ctx.decide`**：Core 在无 decider 时默认 ALLOW 是通用契约，
  **不是** Moments 的生产行为。adapter 的 ALLOW 一律记为 `reason:'policy-allow'`
  （Core 侧 reason 仍是它自己的 `default-allow`，两者分开报告，谁说了算一目了然）。
- Core 的 hard gates（duplicate / cooldown / cancelled / invalid-action）**先于** policy 生效；
  adapter 只做事实搬运，不改 Core、不绕 Core、不复制词表。
- `deps.extraPolicy` 是**唯一**的策略扩展接缝（供 2B/2C 做 quiet-hours 之类的加严或 DEFER），
  返回未知 decision ⇒ Core 记 `decision-failure` ⇒ DENY。

## 7. Executor boundary

```
executeMomentPost(action, deps) → deps.writeMoment(moment, options)
                                 （生产默认解析 IB.moments.createMoment）
```

- executor **不是** decision layer：不重新做 recommendation / policy / cooldown / duplicate；
- 写入 payload：`{ id: 稳定身份, authorType:'role', roleId: actorId, content, source:'proactive',
  visibility, visibleRoleIds, motive, images }`；
- ALLOW + 写入失败 = `ok:false`（**不是** DENY）；返回 `{decision:'allow', executed:true, written:false, error}`；
- 图片只允许已有 payload 或空数组（本阶段不接 Image Router / 不生成图）。

## 8. Decision semantics

| 决策 | executor | Moment | trace |
| --- | --- | --- | --- |
| ALLOW | 恰好一次 | 恰好一行（同一 candidate 重试仍是一行） | Core 记录 |
| DENY | 0 | 0（不写"今天没什么想发的"占位） | Core 记录 |
| DEFER | 0 | 0 | Core 记录 |

DEFER：当前候选**不发布、不保存、不排队、不 `setTimeout`、不自动重试**。
未来 scheduler 再次触发时会重新产生候选（这是"scheduler 拥有触发权"的全部含义）。

## 9. Manual path exemption

用户手动发帖（`authorType:'user'` / `source:'manual'`）**完全绕过**本 adapter：

```
composer / 社交网络页 → createMoment（source:'manual'）
```

零 Autonomy Core 调用、零 recommendation、零 cooldown、零新开关。adapter 对 `source:'user'`
显式 `unsupported-source` —— 用户动作不该被自主策略二次裁决。

## 10. Canonical Moment writer authority

`moments.js` 里 Moment 的落盘通道收敛为**唯一**函数：

```
_momentsWriteCanonical(m, { requestId })       // 只有这一个写点
  · Home Node 面可用 → IB.homeNode.moments.put(m, { requestId })   // 权威 = Home Node
  · 面不可用         → dbPut('moments', m)                        // 本地 / mirror 回滚路径
```

- 三个创建者共用它：手动发帖、自主发布（`generateRoleMoment → createMoment`）、
  companion ingest（`requestId = 'moment-ingest:' + moment.id`）；
- 路由规则**只在写入权威里**：adapter 不知道 IndexedDB / Home Node / canonical / mirror 的存在；
- `createMoment(data, options)` 新增可选参数：`options.id`（稳定身份）、`options.requestId`（权威幂等键）、
  `options.presentation:false`（纯持久化）；缺省行为与迁移前逐字一致；
- 返回 `{ok, moment, persistence:{authority, outcome, revision}}`：`moment` 仍是**本地归一后的行**
  （保持既有调用方可见形状），`persistence` 说明这次到底写到哪一层。

### 10.1 canonical mode gap closure（本阶段唯一的 production 行为变化）

`home-node-bootstrap` 在权威生效时拒绝 `dbPut('moments')`（`moments-write-closed`），
而此前 `moments.js` **没有接通**合法通道 ⇒ canonical 承载下创建一条动态必然失败。
本阶段把它接上：canonical 下 `createMoment` 经 `IB.homeNode.moments.put` 合法成功，
且**不再**触发 `moments-write-closed`；直接 `dbPut` 仍然被拒（守卫未被削弱）。

这是 bug fix / authority closure，不是语义变化：mirror / file:// / 无 Home Node 面的
行为与迁移前一致（同一 IndexedDB store、同一形状、同一返回值）。

### 10.2 Side-effect separation

落库之后的**表现层**副作用（UI 刷新 + AI 点赞/评论/@ 管线）集中在 `_momentsPostWriteEffects`：

- 默认（`presentation !== false`）行为与迁移前一致；
- `presentation:false` ⇒ 纯持久化：页面没打开、没有 DOM、没有 UI 权限也能成功写入；
- 表现层不是落盘前置条件，也不是 executor 的权限。

## 11. Idempotency

```
candidateId → momentId = 'mom'_ + stableToken(candidateId)   // 稳定写入身份
```

- 同一个 candidate 的**同一次逻辑执行**被重试 ⇒ 同一个 Moment id ⇒ 权威侧
  `requestId = candidateId` 判定 `replayed` / 内容等价 ⇒ `skipped` / 本地 upsert 覆盖同一 key：
  **只有一行**；
- 手动路径继续使用原来的 `_momentsId()`（`Date.now` + random）—— 稳定 id 只用于自主候选。

**幂等 ≠ 重复**

| | 回答的问题 | 判据 | 失败时的语义 |
| --- | --- | --- | --- |
| Idempotency | "同一个 candidate 的同一次执行被重试了吗？" | candidateId → 稳定 Moment id + requestId | 写安全（不产生第二行） |
| Duplicate policy | "最近是不是已经发过类似内容？" | 现有去重（写入侧文本相似度）+ 本阶段新增的**精确文本**跨会话判定 | 策略决策（DENY） |

文本相似度**不是**幂等机制，反之亦然。

## 12. Cooldown & duplicate facts

- **Runtime duplicate**：Core 的 `same actor + actionType + fingerprint within window`；
  adapter 的 `fingerprint = topicFingerprint`，时间来自注入的 `deps.now`；
- **Cooldown**：adapter 只把既有调度事实（`lastPostAt` / `cooldownMsFor` / 频率间隔）转成
  Core 的 `ctx.cooldownMsFor`，并把 `lastPostAt` 种进 Core 的 runtime 账本（`state.lastExecuted`）——
  **具体分钟数不进 Autonomy Core**，也不新增 cooldown store；
  cooldown 来源读失败 ⇒ `cooldown-unavailable` ⇒ DENY（Core 对 cooldownMsFor 抛错是"不阻断"，
  所以 adapter 绝不把会抛错的函数交给它）；
- **Cross-session duplicate**：从 canonical Moments 历史派生（读口注入，生产应复用
  `getRoleMoments` / `_momentsRecentOwn` 这一层只读 helper），**不新增 store、不复制 query**；
  本阶段只做精确文本判定，相似度仍归既有管线。

## 13. Trace

- 统一使用 P25 Core 的 runtime trace（环形上限、内存 only）；
- 只有"连 action 都构造不出来"的极早期拒绝（输入不是对象 / Core 缺席）由 adapter
  按**同一 entry 形状**记账；其余全部经 Core；
- trace 不写入 Moment、不写 localStorage、不展示 recommendation reason 给用户。

## 14. P23 / P24 / 其它域边界

- P23 五核心、P24（`communication.js` / `group-runtime-core.js`）**零修改**，测试以冻结 SHA-256 守卫；
- Autonomy Core（`autonomy-core.js`）**零修改**（同样以冻结 hash 守卫）；
- 不引用 Group Brain / Middle Brain / Memory / Diary / Active Message / Economy / Image Router；
- adapter 源码守卫：无模型调用、无 provider 调用、无 `localStorage` / `indexedDB` /
  `document`、无定时器、无 scheduler 符号。

## 14.5 P25-2B · Semantic Recommendation

2B 把「一次模型调用同时返回 publish + content」收敛成
「一次模型调用返回结构化 recommendation + draft」：

```
Trigger → Candidate Seed → ONE model call
        → { recommendation, reasonCode, topicKey, draft }
        → Moments Autonomy Adapter → P25 Autonomy Core → ALLOW / DENY / DEFER
        → Executor → canonical Moment writer
```

实现位置：

- `assets/js/moments-semantic-core.js`（UMD 纯模块：唯一 parser + topic fingerprint +
  兼容投影；浏览器 `window.IBMomentsSemanticCore`，随 `InternalBeyond.html` 在
  `moments.js` 之前加载）；
- `assets/js/moments.js`：`evaluateRoleMomentSemantic()`（真实模型接缝，
  **只评估**）+ `generateRoleMoment()`（LEGACY UNTIL P25-2C 兼容桥）。

### 14.5.1 Semantic output contract

```js
{ recommendation: 'post' | 'skip',
  reasonCode:     '<闭集码>',
  topicKey:       '<话题标识：2-6 个词，用 - 连接>',
  draft: { content, visibility, visibleRoleIds, motive, wantImage, imagePrompt } }
```

- `recommendation` 闭集只有 `post` / `skip`：模型**不能**返回 permission
  （`allow` / `deny` / `defer` 属于 Autonomy Policy）。`recommendation:'post'`
  绝不等于 ALLOW；
- `draft` 只是**候选内容**：权限永远在 policy + Core 手里，draft 不拥有发布权；
- `recommendation:'skip'` ⇒ draft 可以缺省；即便模型给了 draft 也**一律忽略**
  （`ignoredDraft:true`），绝不因为"草案看起来很好"而偷偷发布；不写 placeholder；
- 禁止推理字段：`thinking` / `cot` / `chain_of_thought` / `reasoning` / `analysis` /
  `rationale` / `explanation` / `scratchpad` / `steps` 出现即 malformed ——
  绝不保存、绝不进 trace、绝不展示给用户。

### 14.5.2 reasonCode 闭集（由现有动机枚举与现有 prompt 语义收敛而来）

| 方向 | 闭集 |
| --- | --- |
| post | `meaningful-moment` · `personal-feeling` · `reflection-on-recent` · `interaction-followup` · `curiosity-share` · `social-response` |
| skip | `nothing-to-share` · `too-similar-recent` · `low-substance` · `no-context` · `unsuitable-content` |

方向必须一致：post 配 skip 理由（或反之）⇒ malformed。`reasonCode` ≠ `motive` ≠ `topicKey`
：三者语义分开，各自有自己唯一的真源。旧 UI 文案用的短标签是
`MOMENT_SEMANTIC_REASON_LABELS`（键就是上面的闭集，不是第二套词表）。

adapter 侧：reasonCode 契约升级为
`moment-recommendation/v2`（`MOMENT_CONTRACT_VERSION`）——v1 占位词表（2A）保持可用，
校验取并集；v2 词表的唯一真源是语义核，adapter 不复制它。

### 14.5.3 topic identity 与 topicFingerprint 派生

```
模型给出 topicKey（话题提示，不是正文）
  → normalize（去空白/标点归一为 -、折叠、长度 ≤40、禁控制字符与成句标点）
  → 校验（不得等于/完整包含正文；超长或像一句话 ⇒ malformed）
  → stableToken('moment-topic|' + topicKey) → 'mt_xxxx' = topicFingerprint
```

- 指纹**由程序派生**，模型不拥有 candidate identity（它给的都是提示）；
- 改措辞、换角度描述同一件事 ⇒ 同一 topicKey ⇒ 同一 fingerprint；
  真的换话题 ⇒ 不同 fingerprint；
- 绝不把 `topicFingerprint` 设成正文、标题或模型给出的任意 hash；
- 为了正文兼容性，旧契约（`publish:true`）的 fingerprint 由**结构化字段**
  （motive 派生的 reasonCode + 正文长度档）确定性派生，绝不用正文本身。

### 14.5.4 Candidate Seed → Final Candidate

```
Candidate Seed { actorId, triggerRef, context? }      ← Trigger 先给出
        ↓ 语义评估（一次模型调用）
{ topicFingerprint, draft }
        ↓ finalizeMomentCandidate(seed, semanticRecommendation)   ← adapter 侧唯一身份权威
Final Candidate { candidateId, actorId, source, triggerRef, topicFingerprint, context? }
```

- `candidateId` 仍只由 `buildMomentCandidate` 派生（同 actor/trigger/topic ⇒ 同 id）；
- 去重重写（同一话题换措辞）**不产生**新 candidate identity；
- skip 且没有话题身份时**不产生**候选（skip 本身就是决定性结论）；
- `source` 仍只允许 `schedule` / `character`（`user` 显式拒绝）。

### 14.5.5 Draft contract 与 malformed 判定

draft 沿用既有字段与既有约束：`content` ≤2000（与 canonical store 同源）、
`visibility` 只能是既有四档（缺失 → `all`，拼错 → **malformed**，绝不兜底成公开）、
`roles` 必须带非空 `visibleRoleIds`、`motive` 用既有 `MOMENT_MOTIVES`
（缺失 → `daily_life`，非法 → malformed）、`wantImage` / `imagePrompt`
（`imagePrompt` 上限 600，`includeImage` 旧字段仍归一为 `wantImage`）。

malformed（不发布、不重试到无限）包括：未知 recommendation / 未知 reasonCode /
方向错 / post 缺话题身份 / post 的 draft 为空 / visibility 非法 / roles 空名单 /
motive 非法 / 出现推理字段 / 话题像正文 / 字段超长 / 新旧契约同时出现。

### 14.5.6 One model call rule 与 malformed retry

- 一次候选语义评估 = **一次**逻辑模型调用；
- 既有 malformed-correction 与 duplicate-rewrite 重试共用 `MOMENT_MAX_ATTEMPTS`
  （最多 1 次原始 + 1 次纠正），属于既有 generation failure recovery；
- correction 提示**只**要求新的结构化契约（由语义核生成，绝无 `publish/content` 回退）；
- 第二次仍 malformed ⇒ 失败（不 publish、不 placeholder、不默认 post/allow）；
- provider 错误 / 超时 / 解析失败 ⇒ semantic evaluation failure，绝不 fallback 发布。

### 14.5.7 推荐 ≠ 权限（model / adapter / executor 三方边界）

| 层 | 做什么 | 绝对不做 |
| --- | --- | --- |
| Moments semantic generator | 一次模型调用 → recommendation + draft | 写库、生图、裁决、决定权限 |
| Moments Autonomy Adapter | candidate 身份 + fail-closed policy + Core 适配 | 调模型 / provider（源码守卫 0 引用） |
| P25 Autonomy Core | ALLOW / DENY / DEFER | 生成内容、写业务数据 |
| Executor | 把**已授权** action 交给 canonical writer | 重新推荐 / 重新裁决 |

### 14.5.8 Legacy 兼容（LEGACY UNTIL P25-2C）

- 旧 `{publish:true, content, visibility, motive, wantImage, imagePrompt}` 与
  `{publish:false, reason}` 仍然被接受，但只作为**一处**兼容 seam 投影进新契约
  （`publish:true → recommendation:'post'` + 由 motive 派生的 reasonCode）；
- `publish:true` 绝不等于 ALLOW：它只是 recommendation 的来源之一；
- `generateRoleMoment` 现在是兼容桥：语义评估 → （skip：静默不发）/
  （post：既有图片增强 + `createMoment`）。它**不是**长期权限权威；
- legacy 的原始 `reason` 文本只用于旧 UI 文案（返回给调用方的 `reason`），
  绝不进入 candidate / action / Moment / Autonomy trace；
- `_momentsParseOutput` 保留为 legacy 形状视图（旧调用方与旧测试看到的字段）。

### 14.5.9 Scheduler / 图片 / 去重边界

- scheduler **未迁移**：`_activeTick → _momentsTick → _momentsLocalTick → generateRoleMoment`
  仍是唯一生产触发；`active-diary.js` 与 `active/moments.js` 逐字节未改；
  本阶段没有任何生产文件引用 `IBMomentsAutonomy`；
- 图片：仍在 `recommendation:'post'` 之后才可能生成（skip 路径零图片调用）；
  语义评估函数本身零生图；Image Router 未改；
- 去重：既有内容级相似度防线保留（语义 draft 生成后触发），
  `topicFingerprint` 是候选语义身份 —— 两者互补，不互相替代；
  重写提示明确"话题没变时 topicKey 必须保持原样"。

## 14.6 P25-2C · Scheduler / Trigger Migration（生产接线完成）

2C 把 autonomous 触发从"调度器 → `generateRoleMoment` 自己决定发布 → `createMoment`"
迁移为唯一管线：

```
scheduler（只产出 Candidate Seed）
  → evaluateRoleMomentSemantic()        （一次模型调用：值不值得发）
  → finalizeMomentCandidate()           （候选身份）
  → runMomentAutonomy() → Autonomy Core （是否允许：ALLOW / DENY / DEFER）
  → ALLOW → 图片生成 → Executor → createMoment → _momentsWriteCanonical
```

依赖层：`moments-autonomy.js` 与 `autonomy-core.js` 现在真的在页面里
（`InternalBeyond.html`，与 `chat-core` / `voice-message-core` 同层，
`moments-semantic-core.js` 仍在 `moments.js` 之前）。adapter 与其依赖都按**调用时**解析，
因此脚本放置只约束"使用时刻"。

### 14.6.1 Scheduler 责任（只剩触发）

- `_momentsTick` / `_momentsLocalTick` **逐字未改**：频率（`nextAt` / `MOMENT_FREQ`）、
  最短间隔（`MOMENT_MIN_INTERVAL`）、多标签互斥（`claimUntil`）、失败退避、
  `nextAt` 脏数据自愈全部原样；
- scheduler 产出 `buildMomentCandidateSeed(roleId, opts)`：
  `{actorId, source, triggerRef}` —— 没有 candidateId、没有 recommendation、没有 publish 判断；
- `triggerRef` 必须**确定性**（禁 `Date.now` / `Math.random`）：
  `schedule:<本次调度槽位>`（槽位 = 既有 `nextAt` 状态）⇒ 同一槽位重试得到同一个候选；
  其它触发用调用方给的 ref，否则退回 `lastPostAt + 槽位` 水位；
- `manual`（用户点「让 TA 发一条」）映射为 `source:'character'`（用户手动发帖本身
  走 composer → `createMoment`，根本不经过这里）。

### 14.6.2 频率 / 冷却兼容（不许有第二套规则）

- 冷却只在**调度路径**生效（`cooldownMs = MOMENT_MIN_INTERVAL`，与 tick 的最小间隔同一规则）；
- 手动触发沿用迁移前行为：**没有**冷却（否则"同样条件下 trigger 次数"会变）；
- runtime duplicate 账本按**每次调用**新建：跨调用的去重/幂等靠
  candidateId → 稳定 Moment id + `requestId`，而不是靠一个长期运行的去重窗口
  （后者会误伤"用户连续手动请求"这类合法行为）；
- `declineStreak`：语义 `skip` 才 +1（"角色不想发"）；policy `DENY` / `DEFER` 不动它
  （那是"这次不允许/推迟"，不是角色的选择），并单独记 `post_blocked` 观测。

### 14.6.3 图片时机（2C 的重点）

```
旧：semantic → image → autonomy      （DENY/DEFER 也白烧一次生图）
新：semantic → autonomy → ALLOW → image
```

图片生成移进 executor 的写入桥 `_momentsWriteApprovedMoment` —— 它**只**由
`runMomentAutonomy` 的 executor（ALLOW 分支）调用。因此：
`skip` / `DENY` / `DEFER` 的 image router 调用数 = 0；图片失败仍按既有降级
（保留纯文字，绝不重走 semantic、绝不重复创建 Moment）。

### 14.6.4 Executor 边界

`_momentsWriteApprovedMoment` 只做两件事：生成图片（可选）+ 调 `createMoment`。
它不重新判断 recommendation / policy / cooldown，也不调模型（源码断言：无
`recommendation` / `reasonCode` / `cooldown` / `decide(` / `prefs` / `_obsCall` /
`callAutoChat` / `evaluateRoleMomentSemantic`）。

### 14.6.5 Legacy 退役

- `generateRoleMoment` 现在是 **LEGACY WRAPPER**：构造 seed → 调 autonomous 管线 →
  把结果翻译回旧调用约定（返回值 / 观测 / `declineStreak` / `lastPostAt`）。
  它**不再**是 permission authority，内部也没有直接写入路径
  （`createMoment` 只在 executor 的写入桥里被调用一次）；
- legacy `publish:true/false` 只剩**投影**（`publish:true → recommendation:'post'`），
  仍然要过 policy + Core 才可能写；
- legacy 输出的候选身份 = `momentTopicFingerprint('legacy-<reasonCode>|<正文>')`：
  没有话题信息时用"这一条草案"当身份（哈希，不是正文），同一草案重试幂等，
  不同草案不会被误当成重试而吞掉。

### 14.6.6 已知的未迁移面（2C 之外）

- **companion（Node 侧）调度**：`_momentsTick` 在 companion 在线时仍把调度权交给它
  （`services/home-node` + `active/moments.js` 的旧契约生成路径）。那条路径**不在
  本阶段的允许写集内**，因此"所有 autonomous Moment 都经 `runMomentAutonomy`"这条
  不变量当前对**桌面自调度路径**成立，对 companion 侧**尚未成立** ——
  见 §16.1 第 12 条；
- 点赞 / 评论 / 删评 / 删除的 mutation authority debt 不变（§16.1 第 1 条）。

## 14.7 P25-2D · Companion Runtime Convergence

2D 让 **companion autonomous Moment** 与 **desktop autonomous Moment** 收敛到同一套权限语义：

```
∀ autonomous Moment（desktop scheduler / companion scheduler）
  Trigger → Candidate → Semantic Recommendation → Autonomy Decision
          → ALLOW only → Canonical Moment Write
```

### 14.7.1 两个 runtime 与最终权限落点

| | Desktop | Companion |
| --- | --- | --- |
| 触发 | `_activeTick → _momentsTick → _momentsLocalTick`（companion 在线时让出） | `active/moments.js momentsTick → executeMomentSchedule`（浏览器离线/让出时由它独占） |
| 语义 | `evaluateRoleMomentSemantic`（browser） | `buildMomentPrompt` + `parseMomentSemantic`（**同一份** semantic core） |
| 候选身份 | `finalizeMomentCandidate`（browser） | 不生成身份：只给 `trigger_ref`（recurrence 槽位）+ topic |
| 裁决 | `runMomentAutonomy`（browser） | **也在 browser**：事件回传后由 ingest 裁决 |
| 写入 | executor → `createMoment` | 同一条 executor 路径（事件 ingest 后） |
| 图片 | ALLOW 之后（executor 内） | ALLOW 之后（ingest 的 executor 内） |

**最终权限落点 = 浏览器 ingest**（§7 的 B 方案）。理由（基于真实代码）：
canonical 写入、真实 prefs（`ib_moments_prefs_v1`）、canonical 历史、cooldown 状态都在浏览器侧；
companion 既不写 canonical store，也只持有浏览器同步过来的快照。
**只有一次裁决**：Node 不再判断发布，浏览器不重复判断。

### 14.7.2 共享语义契约（唯一 parser）

`active/moments.js` 直接 `require('../assets/js/moments-semantic-core.js')` —— 桌面与 companion
**同一份实现**：reasonCode 闭集、topic 归一、`momentTopicFingerprint`、禁 CoT 字段、
draft 契约（content ≤2000 / visibility 四档 / roles 名单 / motive 枚举 / wantImage / imagePrompt）、
prompt 的 JSON schema 文本、correction 提示。
旧 `publish:true/false` 在两端都只剩**一处兼容投影**（`publish:true → recommendation:'post'`）。

### 14.7.3 Event envelope（候选，不是许可）

```js
{ id, kind:'moment', status:'moment_sent',
  actor_id, source:'schedule', trigger_ref:'companion:<recurrence 槽位>', slot_at,
  semantic_contract:'moment-semantic/v2',
  recommendation:'post', reason_code, topic_key, topic_fingerprint,
  draft:{ content, visibility, visibleRoleIds, motive, wantImage, imagePrompt },
  /* legacy 字段（旧浏览器兼容；新浏览器把它们当兼容投影，不当作许可） */
  moment_id, character_name, moment, content, visibility, motive,
  want_image, image_prompt, decline_streak, next_at, last_post_at }
```

- 允许的只有业务字段；**不允许** provider / endpoint / apiKey / raw cfg / raw system prompt /
  CoT / 推理 / telemetry blob（测试断言 event JSON 里没有这些）；
- `trigger_ref` 用**本次触发的 recurrence 槽位**（`due`），确定性、可重放；
  不用 `Date.now` / `Math.random` / 事件到达时间；
- **收到 `kind:'moment'` 不等于允许发布**：浏览器 ingest 必须走
  semantic 校验 → finalize → `runMomentAutonomy` → ALLOW 才写。

### 14.7.4 Ingest 迁移（browser）

```
旧：event → (want_image → 图片) → _momentsWriteCanonical(event.moment)
新：event → _momentsCompanionSemantic（同一 parser：新 envelope 结构化 / 旧 envelope 兼容投影）
          → finalizeMomentCandidate（canonical Moment id 由 candidateId 派生）
          → runMomentAutonomy（真实 prefs / history / cooldown）
          → ALLOW only → 图片 → executor → createMoment → _momentsWriteCanonical
```

- 畸形 / 未知词 / 禁字段 / 缺话题 ⇒ **消费但不写**（fail closed，且 ack 以免无限重投）；
- Deny/Defer ⇒ 不写、不生图、不排队、不重试；只把"slot 已被消费"同步进本地状态；
- 幂等：同一事件重放 → 同一 candidate → 同一 Moment id → 早退（不重复消耗图片）；
  同一话题换措辞（不同事件）同样收敛到同一行。

### 14.7.5 prefs / history / cooldown 权威（未复制）

- prefs 仍是 `ib_moments_prefs_v1`（浏览器侧唯一真源）；companion 快照里的
  `prefs.enabled` + `schedule.enabled(=autoPublish)` 只用于**避免无用模型调用的早退**，
  不是权限判定；不存在 `companion_moments_prefs` 之类的第二套设置；
- 跨会话 duplicate 仍来自 canonical Moments 历史（`readRecentOwnMoments`）；
  companion 不建 duplicate store；
- cooldown 仍是同一条规则（`MOMENT_MIN_INTERVAL = 45min`）：桌面调度路径与 companion
  事件 ingest 都按它判定；不新增第二套 cooldown。

### 14.7.6 online / offline ownership（未改）

companion 在线 → `_momentsTick` 让出调度权（只拉事件 + 同步），桌面不产生第二个 autonomous Moment；
companion 离线 → 桌面 scheduler 正常接管；切换 online/offline 时**同一 slot 不双触发**
（ingest 会把 `next_at` 同步进本地状态，桌面 tick 因而看到未来槽位）。

### 14.7.7 legacy wrapper / v1 词表状态

- `generateRoleMoment` 仍是 **LEGACY WRAPPER**（内部只经 autonomous 管线，无直接写入路径）：
  桌面 scheduler 与「让 TA 发一条」仍用它 → **暂不退役**；
- v1 reasonCode 兼容词表（2A 占位集）仍保留：2D 之后桌面与 companion 都已走 v2 语义契约，
  但 2A 的冻结契约与测试仍依赖 v1 词表可接受 ⇒ **保留并标记**，退役留给后续清理阶段。

### 14.7.8 production create-path 枚举（Closure 依据）

| 路径 | 分类 | 是否经 Autonomy |
| --- | --- | --- |
| composer / 社交网络页 → `createMoment(source:'manual')` | MANUAL | 否（**唯一允许的绕过**，且零 autonomy 调用） |
| 桌面 scheduler → `generateRoleMoment` → `_momentsRunAutonomousPost` | AUTONOMOUS | **是** |
| 「让 TA 发一条」→ `generateRoleMoment` → 同一管线 | AUTONOMOUS（source `character`） | **是** |
| companion 事件 → `_momentsIngestEvent(kind:'moment')` | AUTONOMOUS | **是**（2D 起） |
| `moment_reply` / `moment_comment_deleted` ingest | MUTATION（评论） | 不适用（mutation debt，见 §16.1 第 1 条） |
| `createMoment` / `_momentsWriteCanonical` 本身 | SYSTEM（唯一创建/落盘权威） | 被上面三条创建路径共用 |

companion 域自身：`createMoment` / `_momentsWriteCanonical` / `dbPut` 引用 = **0**。

## 15. Production migration status

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P25-2A | adapter foundation + canonical 写入通道收敛 | **本阶段完成** |
| P25-2B | 语义推荐（一次模型调用，recommendation 与草稿分离） | **完成**（见 §14.5） |
| P25-2C | scheduler / trigger 迁移（新路径成为唯一生产触发） | **完成**（见 §14.6） |
| P25-2D | companion runtime 收敛（事件不是许可；两个 runtime 同一契约） | **完成**（见 §14.7） |

2D 之后：**所有 autonomous Moment（桌面 scheduler + companion 事件）** 只有一条权限路径 ——
scheduler/companion 产生候选 → semantic（推荐）→ finalize（身份）→ Autonomy Core（裁决）→
ALLOW only → executor（图片 + 写入）。`generateRoleMoment` 退化为 legacy wrapper；
companion 域零直接写入引用；手动发帖（composer / 社交网络页）仍完全不经过 autonomy。

## 16. Known risks / limitations

1. **更新路径仍在权威之外**：点赞 / 评论 / 删评 / companion 评论回传仍是 `dbPut('moments')`
   （canonical 承载下会被守卫拒绝）。本阶段只收敛**创建**权威；更新路径的收敛属于后续阶段。
2. 删除路径同理（`deleteMoment` → `dbDelete`）。
3. `_momentsPrefs` 在生产环境是**全函数**（读不到就返回默认值），因此
   `prefs-unavailable` 分支主要靠注入读口才能触发；"用户关掉了开关"在配置层仍以
   `enabled === false` 形式表达。
4. 跨会话重复判定只做精确文本；真正的话题级相似度留给 2B/2C（与既有相似度管线合并）。
5. `deps.now`、`deps.lastPostAt`、`deps.readRecentOwnMoments`、`deps.writeMoment` 目前都由调用方注入：
   2C 必须把它们接到真实调度状态与 `createMoment`，否则 adapter 只会 fail closed（这是刻意的）。
6. 内容安全只覆盖"明显 secret 形态"（复用 `voice-message-core.findSecret`）与注入式
   `contentSanitizer` 接缝；完整的私密披露（`disclosureFacts`）不在本阶段。

### 16.1 P25-2B 新增的已知限制 / 刻意收紧

7. **模型输出档位收紧**：旧 parser 把拼错的 `visibility` 写成 `'invalid'`（落一条
   谁都看不见的脏行）；新 parser 直接判 malformed ⇒ 走 correction 重试，而不是落脏行。
   这是 fail-closed 方向的收紧，不是行为回退。
8. **`_momentsParseOutput` 只是 legacy 视图**：它仍服务旧调用方与旧测试，
   但 canonical 形状是 semantic result。P25-2C 之后应逐步退役该视图。
9. **`generateRoleMoment` 仍是旧权限来源**（LEGACY UNTIL P25-2C）：它虽然已经消费
   recommendation，但**自己**决定写不写、什么时候生图。2C 必须把这条路径换成
   `runMomentAutonomy` + executor，否则"模型推荐 → policy → Core"的链条在
   autonomous 路径上仍然只被"经由 recommendation"间接约束。
10. **legacy 路径仍在 autonomy 之前生图**：语义评估不生图（skip 路径零图片调用），
    但旧桥在 `recommendation:'post'` 之后、Autonomy 裁决之前生图。真正的顺序迁移
    （先裁决后生图）属于 2C。
11. **原始 legacy reason** 仅存在于旧桥返回值；新契约不再请求自由文本理由，
    telemetry 记录的是 `reasonCode` + `topicFingerprint`。

### 16.2 P25-2C 新增的已知限制

12. **companion 侧调度未迁移**：companion 在线时 `_momentsTick` 把调度权交给它，
    而它的生成路径（`services/home-node` + `active/moments.js`）仍是旧契约、
    且不在本阶段允许写集内。因此"所有 autonomous Moment 经 `runMomentAutonomy`"
    当前只对桌面自调度路径成立；companion 路径的等价迁移需要单独阶段
    （涉及 Node 侧生成契约，不能顺手改）。
13. **`generateRoleMoment` 仍在**（legacy wrapper）：它不再是权限来源，但仍是
    scheduler 与旧调用方的入口。真正的"一个入口"要等 companion 迁移完成后才能收。
14. **图片仍在 executor 内生成**：顺序已经正确（ALLOW 之后），但图片
    provider 的并发/优先级仍由既有 Image Router 决定 —— 本阶段只改时序，不改路由策略。
15. **runtime duplicate 账本按调用新建**：跨调用的幂等完全依赖 candidate 身份；
    如果一个候选在两次调用之间 topicKey 变了（模型不稳定），那两次会被当作两个候选
    （这正是"话题变了就是新候选"的语义，但也是模型不稳定时可能多发一条的来源）。

### 16.3 P25-2D 后的已知限制

16. **companion 侧记账是"触发记账"**：companion 生成候选后就推进自己的
    `nextAt/lastPostAt/declineStreak`，而最终写不写由浏览器裁决。若浏览器 DENY/DEFER，
    companion 的那份 `recent_moments/lastMomentId` 会暂时偏乐观 —— 下一次快照同步
    （浏览器把 canonical 行回推）会覆盖它，因此偏差有界且自愈；
17. **事件里的 `moment_id` 只是临时/兼容字段**：canonical Moment id 由 candidateId 派生
    （两端同一身份语义）。旧浏览器仍会用它直接落库（那是 2D 之前的行为），
    新浏览器忽略它——版本偏斜期间同一事件可能得到不同 id；
18. **companion 的 reply/comment 路径仍用旧契约**（评论 autonomy 本阶段明确禁止触碰）：
    `parsed.publish === false` 仍出现在回复链（评论）路径里，那是另一个契约，
    不计入"创建路径的第二个权限权威"；
19. **`generateRoleMoment` 与 v1 reasonCode 词表都还在**（见 §14.7.7），
    退役需要先证明没有生产调用方依赖它们；
20. **companion 快照仍是"浏览器决定给什么"的上下文**：它携带 recent_memories 等业务字段，
    本阶段没有接 Memory authority / disclosureFacts（§30 明确禁止）。

## 17. P25-2B / 2C 前置

**2B（语义推荐）**：**已完成**，见 §14.5。

**2C（scheduler 迁移）**：**已完成**，见 §14.6。

**P25-2 Closure 状态**：Desktop autonomous create 与 Companion autonomous create
都已证明 Autonomy required ⇒ **READY**（见 §14.7.8 的 create-path 枚举）。

**P25-3 前置（下一个自然阶段）**：

- Moments **Mutation Authority Closure**（点赞 / 评论 / 删评 / 删除的 canonical 写入），
  以及 companion 回复链契约与它的收敛；
- 内容安全（`disclosureFacts` / 私密披露）与 Memory 上下文的正式接入；
- 清理项：`generateRoleMoment` legacy wrapper 与 v1 reasonCode 兼容词表的退役
  （需要先证明没有生产调用方依赖）。这些都必须是独立阶段，不得顺手塞进管线。
