# P25-3D · Role Letter Capability Integration

状态：**Role Letter Capability INTEGRATED**。Role Letter（AI↔AI 私信）的**写信权限**
第一次离开模型 / 调度器 / executor：cadence 写信与读信后回信两条生产路径共用
**同一个** Role Letter Authority 与**同一条** canonical writer（`roleLetters` 只剩一个写点）。
P25-3A 编排契约、P25-3B Diary、P25-3C Active Message（含 Node companion）全部零修改。

实现位置：

- `assets/js/role-letter-authority.js`（唯一写信权限：candidate → decision → 仅 ALLOW 才执行）
- `assets/js/agent-orchestration-role-letter-adapter.js`（`role_letter.write` descriptor + route + verifier）
- `assets/js/role-letters.js`（生产收敛：`_rlStoreLetter` → authority → 唯一 `_rlWriteCanonical`）
- `InternalBeyond.html`（加载 `role-letter-authority.js`；**不**加载编排 adapter —— 编排层仍是 foundation-only）
- 测试：`tests/test_role_letter_authority.js`（RL1–RL16）、
  `tests/test_agent_orchestration_role_letter_adapter.js`（OA1–OA12 + PC1–PC8）

---

## 1. Scope

```
（改动前）cadence / 回信 → 模型生成 → _rlStoreLetter → dbPut('roleLetters')   （4 个写点）
（改动后）cadence / 回信 → 模型生成 → **Role Letter Authority** → ALLOW →
          _rlWriteCanonical（唯一写点）→ Verify
```

**非目标**（本阶段明确不碰）：Activity / Cinema / Co-read / Voice / TTS / Memory /
Middle Brain / disclosureFacts / Economy / Group Runtime 接入；P23、P24、Autonomy Core 修改；
DB migration；新 scheduler；新 queue；commit。

**不要因为 Role Letter 有 relationship / memory / emotion / history 就接 Memory 或 Middle Brain**：
本阶段只处理 Capability + Authority。

## 2. Phase 0 audit（只读）

| 问题 | 结论（仓库事实） |
| --- | --- |
| A. 数据结构 | letter：`{ id, fromRoleId, toRoleId, content, kind:'init'\|'reply', createdAt, readAt, replyStatus, parentId? }`；私有记忆：`roleLetterMemories`（owner=characterId，`direction`，`letterId`） |
| B. canonical storage | IndexedDB `roleLetters`（`byFrom`/`byTo` 索引）= **唯一持久化来源**；`roleLetterMemories` 独立私有命名空间；localStorage：state / pair / replyq / prefs；**无 Home Node / 无同步 / 无 migration** |
| C. 所有 writer | 改动前 4 处 `dbPut('roleLetters')`：`_rlStoreLetter`（**唯一新建**）、`_rlReplyStep` 两处（replyStatus 状态更新）、`_rlExp`（readAt 已读标记）。**改动后只剩 1 处**（`_rlWriteCanonical`） |
| D. 谁创建 letter | 角色自己：cadence 主动写信（`_rlInitStep` → `_rlGenerateInit`）与读信后回信（`_rlReplyStep` → `_rlGenerateReply`） |
| E. 谁触发 | 浏览器 `_activeTick`（30s）→ `active-diary.js` 的 `_roleLettersTick`（每角色 `_rlInitStep` / `_rlReplyStep` / `_rlReadMemoStep`）；**没有**独立 scheduler、**没有** Node companion 面 |
| F. 用户主动写信路径 | **NOT PRESENT**（信箱 UI 只有查看 / 已读 / 总开关；没有任何"用户创作 Role Letter"入口） |
| G. 角色主动写信路径 | 存在：cadence（每角色每天约 1 封）+ 回信（延迟 1~6h） |
| H. AI 自动生成 | 存在（本域全部内容都由角色模型生成） |
| I. 模型调用 | `_rlCall` → `window.callApiChat(cfg, messages, {_ibConsumer:'role_letters', jsonMode:true, maxTokens:1600/1400, timeoutMs:90000, disableTools:true})`，每条路径最多 2 次尝试 |
| J. 模型输出如何进入 writer | `_parseJson(raw)` → `{write:true,to,content}`（init）/ `{reply:true,content}`（reply）→ `_rlStoreLetter` |
| K. 是否存在权限判断 | **改动前**：分散在 `_rlIsEnabled()`、`_rlCandidates`（冷却过滤）、`_rlInitStep`（daily cap + claim）、`_rlReplyStep`（队列延迟 + 已回已拒 + lastReplyAt 24h）。**改动后**：Role Letter Authority |
| L. duplicate / idempotency | letter 级：无内容去重（只有 pair 冷却）；状态级：`replyStatus` 防重复回信；私有记忆：`_rlHasRoleMem` + 相似度 ≥0.8 去重 |
| M. identity | letter id = `rletter_<time36>_<rand>`（domain 持有，**本阶段不重新发明**） |
| N. sender | `fromRoleId` = 发送角色 canonical id（`cfg.id`） |
| O. receiver | `toRoleId` = 接收角色 canonical id（cadence 由 `_rlCandidates` 从 `apiConfigs` 选，回信为来件的 `fromRoleId`） |
| P. delete / edit / archive | **不存在**（只有 `readAt` / `replyStatus` 状态更新） |
| Q. notification / delivery | 只有 `toast(...)`（页内提示）；**无** OS 通知、**无** push、**无**交付层 |
| R. Memory 关联 | 读：`_momentsContext` 提供 memories 给 prompt（只读）；写：**只写私有命名空间 `roleLetterMemories`**；另有一次性的历史清理 `_rlCleanupLegacyMemories`（删除 `memories` 里 `source==='role_letter'` 的旧污染行） |
| S. Middle Brain 关联 | **无**（`role-letters.js` 不引用 MB 任何符号） |
| T. relationship 计算 | **只读**：`cfg.relationship` 作为 prompt 事实；`_momentsPairAffinity` 只作候选**权重**。信件写入**不修改** relationship（见 `docs/contracts/letters/LETTERS_AUTHORITY_CONTRACT.md`：`Letters ≠ Relationship`） |

## 3. Call graph（收敛后）

```
_activeTick(30s) → _roleLettersTick()
  ├─ _rlCleanupLegacyMemories()                          （一次性清理，未改）
  └─ for each role cfg:
       ├─ _rlInitStep(cfg, now)                          （cadence：每日 1 封 + 对偶冷却 + claim）
       │     ├─ 既有：nextInitAt 播种 / daily cap / initClaimUntil / _rlCandidates（冷却过滤）
       │     ├─ _rlGenerateInit → callApiChat(jsonMode)  （模型门控 write/to/content）
       │     └─ **_rlStoreLetter** → facts → **_rlRunWrite** → 共享 Authority
       │           ├─ DENY  → 零副作用（不落库 / 不重置冷却 / 不写私有记忆 / 不入回信队列）
       │           └─ ALLOW → _rlWriteCanonical → 既有后置步骤（_rlPairSet / lastInitAt /
       │                     _rlWriteRoleMemory(send) / _rlQueueReply / toast）
       ├─ _rlReplyStep(cfg.id, now)                      （回信：队列延迟 1~6h + lastReplyAt 24h）
       │     ├─ 既有：队列 dueAt / 父信 replyStatus 守卫 / replyClaimUntil
       │     ├─ _rlGenerateReply → callApiChat(jsonMode)
       │     └─ **_rlStoreLetter** → facts → **_rlRunWrite** → 共享 Authority
       │           ├─ DENY  → 不写回信、不改父信状态、不写私有记忆、不计入 lastReplyAt
       │           └─ ALLOW → _rlWriteCanonical + 父信 replyStatus='replied'（状态更新经同一 writer）
       └─ _rlReadMemoStep(cfg.id, now)                    （已读后才写"收件记忆"，未改）
UI：_rlRenderInbox / _rlLoadLettersFor（读）；_rlExp → readAt 标记（经同一 canonical writer）
```

## 4. Classification（§6）

| 分类 | 是否存在 | 实例 |
| --- | --- | --- |
| MANUAL_USER_LETTER（用户直接写 Role Letter） | **NOT PRESENT** | 信箱 UI 没有创作入口 |
| USER_REQUESTED_LETTER（用户请求角色写） | **NOT PRESENT** | 没有"让她写一封信"按钮 |
| AUTONOMOUS_LETTER | PRESENT | cadence（每角色每天约 1 封，模型门控） |
| SYSTEM_LETTER | PRESENT | 回信（读信后延迟 1~6h，模型决定回不回） |
| MIGRATION | **NOT PRESENT** | 无迁移入口 |

## 5. Capability semantics

`role_letter.write` = **“请求一个角色向指定 recipient 创建一封 Role Letter”**（domain capability）
—— 不是 raw DB insert、不是 message send、不是 notification、不是 relationship update。

## 6. Candidate 契约

```
{
  candidateId,   // 'rlc_' + stableToken(actorId|recipientId|source|letterKind|trigger|triggerRef)
  actorId,       // 发送角色 canonical id（fromRoleId = cfg.id）
  recipientId,   // 接收角色 canonical id（toRoleId）
  source,        // 'schedule'（cadence） | 'character'（读信后回信）
  letterKind,    // 'init' | 'reply'
  trigger,       // 'init' | 'reply'
  triggerRef,    // init: 'cadence_<actorId>'；reply: 父信 letter id
  contextRef     // 可选上下文引用（非正文）
}
```

source 是闭集且等于审计到的真实入口：`user` / `manual` 一律 `bad-source` ⇒ DENY。

## 7. Identity

- letter id **仍由 domain 持有**（`rletter_<time36>_<rand>`，未改）；
- `actorId` / `recipientId` 都是 canonical role id（拒绝 nickname / displayName / 临时 id）；
- `candidateId` 是纯派生身份（`chat-core.stableToken`），确定性、可重放、无 `Math.random`/`Date.now`；
- 自寄信件在候选层结构性拒绝（既有 `_rlCandidates` 也排除自己）。

## 8. Authority 契约

`assets/js/role-letter-authority.js`（纯 UMD，浏览器 + Node 双挂载 `IBRoleLetterAuthority`）：
`buildRoleLetterCandidate` / `decideRoleLetterWrite` / `runRoleLetterWrite` / `verifyRoleLetterWrite`；
零 DB / DOM / fetch / provider / 模型 / Memory / Middle Brain / 通知 / scheduler / 定时器，
executor 与 reader 全部注入。

## 9. Decision 语义

闭集 `allow` / `deny`（**无 DEFER**：低频/异步语义已由既有 cadence、对偶冷却与回信队列承担）。
顺序（逐条 fail closed）：

```
invalid-candidate → unknown-actor → unknown-recipient → cancelled
→ disabled → cooldown → duplicate → allow
```

executor 缺席 ⇒ `no-executor`；authority 缺席 ⇒ domain 侧 fail closed（不写），
**绝不**退回旧的直写路径。

## 10. Facts（只读自真实状态；规则仍然只有一份）

| fact | 来源（既有实现，未改写） |
| --- | --- |
| `actorKnown` | `_rlCfg(fromRoleId)` 存在 |
| `recipientKnown` | `_rlCfg(toRoleId)` 存在（归档角色仍可解析；彻底删除的角色 ⇒ DENY，见 §20 限制 2） |
| `cancelled` | 本域没有取消语义 ⇒ 恒为 `false`（队列/状态更新不是取消） |
| `enabled` | `_rlIsEnabled()`（`ib_role_letters_prefs_v1` 总开关） |
| `cooldown` | init：`_rlPairCooldownMs(actor,recipient) > 0`（既有 **24~72h** 对偶冷却）；reply：`false`（回信节奏由既有队列延迟 1~6h + `lastReplyAt` 24h 承担） |
| `duplicate` | reply：父信 `replyStatus` 已是 `replied`/`declined`（既有"已回已拒"守卫，写前 fresh 读）；init：`false`（既有产品只有对偶冷却，**不新增内容去重**） |

## 11. Model boundary

模型只产 `{write,to,content}` / `{reply,content}`；正文与决定**都不构成权限**
（candidate 不含正文；`decideRoleLetterWrite` 函数体内零 `content`/`write` 引用，RL11 用源码切片钉住）。

## 12. Executor

executor = `async () => { 生成 letter id/rec → _rlWriteCanonical(rec) → {ok:true,letter:rec} }`：
只做已授权写入，不重判 enabled / cooldown / duplicate；执行失败 ⇒
`decision:'allow', executed:true, ok:false`（**不是 DENY**，RL10）。

## 13. Canonical writer（§15）

`_rlWriteCanonical(rec)` 是本域唯一的 `roleLetters` 写点（静态守卫：`dbPut(RL_STORE` 只出现 **1** 次）。
**新建** letter 经 authority 裁决；`replyStatus` / `readAt` 的**状态更新**走同一 writer
但不再裁决（它们不是"新建信件"）—— 与 P25-3C 的"投递镜像经同一 writer 不重复裁决"同理。

## 14. Verify

`verifyRoleLetterWrite(result, reader)`：`not-completed` / `missing-letter-id` /
`canonical-letter-missing` / `identity-mismatch`（寄件人）/ `recipient-mismatch`（收件人）/
`{verified:true, letterId}`。只读（reader 注入），**不补写、不 retry**。

## 15. Duplicate / Idempotency（§22）

letter identity 仍是 domain 的 `rletter_*`（未重新发明、未使用 content hash）；
去重复用既有的**对偶冷却**（init）与**已回已拒守卫**（reply），**没有**新增 store、
**没有**新增指纹表；`candidateId` 只作审计/幂等键透传。

## 16. Registry + Adapter

descriptor（遵守 P25-3A frozen descriptor）：

```
{ id:'role_letter.write', domain:'role_letter', kind:'write',
  description:'请求一个角色向指定 recipient 创建一封 Role Letter（经 Role Letter Authority 裁决）',
  sideEffect:'local', authorityType:'domain', binding:'role_letter.write' }
```

`assets/js/agent-orchestration-role-letter-adapter.js`：
`registerRoleLetterCapabilities` / `createRoleLetterOrchestrationAdapter({authority,domain,reader})` /
`invokeAuthority`（只捕获已授权意图）/ `resolveExecutor`（同一步第二次执行被拒）/ `idempotencyKeyFor`
（透传 candidateId 或调用方 key）/ `verify`（async 绑 verifier）/ `describeRoleLetterAvailability`
（只回答基础设施可用性，**不是**权限）。Adapter 零 DB / DOM / fetch / 模型 / Memory / MB / 通知。

**double authority**：与 P25-3B/3C 同结论 —— 不实现 envelope bypass；生产 domain 入口与编排层
共用同一条 authority、同一份 facts，两次都 fail-closed。

## 17. Relationship / Memory / Middle Brain 边界

**Relationship**（§16）：信件写入**不修改** relationship。`cfg.relationship` 只是 prompt 事实，
`_momentsPairAffinity` 只是候选权重 —— 二者属于既有 `LETTERS_AUTHORITY_CONTRACT`
（`Letters ≠ Relationship`），本阶段**不接 Relationship Authority**。
PC8 断言写信前后 `apiConfigs` 逐字节不变、源码零 `relationship=` 赋值。

**Memory**（§17）：0 Memory capability、0 Orchestrator→Memory 边、0 Role Letter→**共享** Memory writer。
既有的 `roleLetterMemories` 私有命名空间（owner=characterId）与 `_rlMemBlock` 注入**原样保留**；
既有的一次性历史清理（`_rlCleanupLegacyMemories`）**只在文档登记，不扩大**。
PC7 断言生产写入只落在 `roleLetters` / `roleLetterMemories` 两个 store。

**Middle Brain**（§18）：0 MB authority、0 MB side effect（RL14 / OA12b 源码守卫）。

## 18. Tests

| 套件 | 覆盖 |
| --- | --- |
| `tests/test_role_letter_authority.js` | RL1–RL16：candidate / 自寄拒绝 / 判定顺序 / 无 DEFER / 执行力 / verifier / 纯度（DB·DOM·模型·Memory·MB·通知）/ 秘密 / CoT / 确定性身份 / source 闭集 / domain 策略与单一 writer |
| `tests/test_agent_orchestration_role_letter_adapter.js` | OA1–OA12（注册 / descriptor / 路由 / Plan != Permission / DENY 零执行 / verifier / 取消 / 身份 / 幂等 / 结果规范化）+ PC1–PC8（真实 `role-letters.js` 生产收敛） |

PC 段在 vm 沙箱里加载**真实生产文件**（chat-core / voice-message-core / role-letter-authority /
role-letters.js），驱动真实 `_roleLettersTick`（cadence + 回信两条路径）。
既有套件 `tests/test_role_letters.js`（41 项端到端）在**同一条** authority 下全绿：
沙箱加载真实 authority 模块；步骤 12 的角色对改为无冷却组合（原组合现在会被对偶冷却正确拒绝，
那是新 authority 的**预期**行为，而非回归）。

## 19. Frozen Guards

| 对象 | SHA-256 | 结论 |
| --- | --- | --- |
| `assets/js/role-letter-authority.js` | `1743B97D…39387C90` | 新增（纯权威） |
| `assets/js/agent-orchestration-role-letter-adapter.js` | `22495952…B11A07A2` | 新增（adapter，未加载进页面） |
| `assets/js/role-letters.js` | `AAE050AB…BF5A43AD` | 收敛（唯一 canonical writer + authority 接缝；原 `B811C7A2…0DF376EE`） |
| `InternalBeyond.html` | `954A9CA2…FA1C50B2` | 加载 `role-letter-authority.js` |
| `tests/test-all.js` | `D20720D0…0049BF28` | 注册两个新套件 |
| `tests/test_role_letters.js` | `F0084214…ABA1D3CC` | 沙箱加载真实 authority（+ 步骤 12 角色对避开既有冷却） |
| `assets/js/autonomy-core.js` | `FE1011F1…9F2956F8` | 逐字节未变 |
| `assets/js/moments.js` | `E23697DE…B82CEE31` | 逐字节未变 |
| `assets/js/diary-authority.js` / `assets/js/active-diary/diary.js` | `BBB7EC88…C95E73A9` / `86C355D6…702B16DA` | 逐字节未变 |
| `assets/js/active-message-authority.js` / `assets/js/active-diary.js` | `CC2A8BF9…AE3892C4` / `D14D4AC6…89ADE8CA` | 逐字节未变 |
| `assets/js/agent-capability-registry.js` / `agent-orchestration-core.js` | `78AE9DFE…273BF7A2` / `BA4A3DFA…AC204F79` | 逐字节未变（P25-3A Foundation） |
| DB schema | — | `DB_VER=24` 未变；store 名与 letter 记录键集未变（PC4/PC7） |

## 20. Known limitations

1. **生成发生在裁决之前**：DENY 时已消耗一次生成调用（单点裁决的代价；收益是"同一个 authority
   只有一个调用点"）。cadence 的退避仍由既有 `nextInitAt` 承担，不产生重试风暴。
2. **回信目标被彻底删除**（不在 `apiConfigs` 也不在 `archivedConfigs`）时：既有实现仍会落库，
   本阶段 `recipientKnown=false` ⇒ DENY（fail closed，不写）。归档角色仍可解析，不受影响。
3. **init 路径没有内容级去重**：既有产品只有对偶冷却，因此 `duplicate` 在 init 恒为 false；
   本阶段**不新增**内容相似度策略（§22 禁止第二 store / content hash 作唯一 identity）。
4. **deny 的呈现**：init DENY 不写任何记录（cadence 退避承担）；reply DENY 不改变父信状态
   （保持 `pending`，可被下次队列评估）；不新增状态词、不新增 UI 文案。
5. **`roleLetterMemories` 不是 Memory 子系统**：它是本域私有命名空间（既有设计），
   本阶段保持原样；不接入 Memory Authority。
6. **编排 adapter 未加载进页面**：`role_letter.write` 只被 descriptor/测试使用，生产触发仍走 domain 路径。
7. **verifier 绑定是 async**（canonical 读是异步的），未修改 P25-3A 的同步 `verifyStepResult` contract。
8. **无删除 / 无编辑 / 无归档能力**：本阶段不登记 `role_letter.delete`（既有产品没有该入口）。

## 21. Deferred work

- `role_letter.delete` / `role_letter.read`（需要新的产品入口与权限面）。
- 若将来新增"用户请求角色写信"入口：扩展 source 闭集（`user`）并单独审计。
- 事件/通知面（当前只有页内 `toast`）不在本阶段范围。
