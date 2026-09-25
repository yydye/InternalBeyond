# P29-0 · Identity Read-Path Closure Report

阶段性质：**缺陷修复 / 最小改动 / 零架构扩展**。
未创建新 capability、未实现 INTERJECT、未做 Event Bus、未做 Group Context Projection。

范围只覆盖"**identity 读路径**"：谁说的（WHO SAID IT）与**这是不是我上一条**（ownership）。

---

## 0. Phase 0 · 只读审计表（`assets/js/communication.js`）

| 位置 | 当前身份来源 | 用途 | 是否安全 |
|---|---|---|---|
| `:378` `_getApiAvatarByName` | `senderName` → `apiConfigs`（find-first） | 头像显示 | safe（display；但同名群里可能取第一个匹配的头像 → 见 §7） |
| `:379-395` `_messageApiConfig` | `metadata.speakerId` → `metadata.config_id` → `friendId` → `senderName`（末位 legacy） | 供 `_messageShowThinking`（`:397`）判定"是否显示思考" | safe（display）；名字分支仅供无 canonical 键的旧消息 |
| `:470-473` `_buildMsgEl` | `senderName`（标签 / 头像回退） | 历史气泡文案与头像 | safe（display） |
| `:481` `dataset.senderId`（群） | `metadata.config_id` →（legacy）`senderName` | 渲染分组键 | safe（display，不参与身份判定） |
| `:1847` `_gInjMine` | `it.actor === selfName`（显示名） | workspace 读取/操作反馈**注入归属**（谁的结果给谁看） | **risk（attribution）**：同名的两个成员会看到同一批 ws 结果 —— 不属 permission / ownership，见 §7 |
| `:2511` 群历史映射 | `_ibGroupClassifyMessage` → M2 `resolveSpeakerId`（canonical `speakerId`） | 决定历史行进 prompt 时是 `assistant`(SELF) 还是 `user`(OTHER) | safe（canonical；M2 冻结路径） |
| `:2512` 历史文本前缀 | `m.senderName` | `[名字] 正文` 转录标注 | safe（display） |
| `:2603` / `:3463` `dataset.senderId`（群流式） | `cfg.id` / `modelConfig.id` | 渲染分组键 | safe（canonical 优先） |
| `:3387` `_chatShouldWithdraw` → `_chatWithdrawMsg` / `_maybePatWithdraw` | 文本里的 `@名字` | 决定"这条回复是否要撤回自己上一条" | safe（**内容启发式**，不是身份判定；真正的目标选择在下游） |
| `:3468` `_isCont` | `senderName` | 气泡续接分组 | safe（display） |
| `:5165` `_chatShouldWithdraw(content)` | 正文中的 `@` token | 文本启发式 | safe（text，不是 identity） |
| `:5176` `_chatWithdrawMsg(msgId)` | `m.senderName`（文案）+ `m.config_id`（查 cfg） | 墓碑文案 / 重渲染 | safe（display；目标已由调用方按 canonical 选出） |
| `:5197-5211` `_maybePatWithdraw` | **旧**：`x.senderName === cur.senderName` → **新**：`_ibGroupClassifyMessage` | 选"上一条同发送者消息"作为撤回目标 | **旧 = risk（ownership）**，已修 → safe |
| `:5251-5266` `_chatWithdrawSelf` | **旧**：`x.senderName === senderName` → **新**：`_ibGroupClassifyMessage` | 选"我上一条"作为撤回目标（群聊可达） | **旧 = risk（ownership）**，已修 → safe |
| `:2467` 群成员身份构造后 | `_gMember` | 决定成员消息是否带 P24 三键 | **旧 = 静默退化**，已加诊断 → safe（语义未变） |
| `:2702` canonical 写入 | `extraMetadata:{groupTurnId,speakerId,groupOrder}` | 群成员消息身份写入 | safe（canonical，M1/M2 冻结三键） |

`displayName / senderName` 的允许用途与禁止用途沿用 `P24-M2-SPEAKER-IDENTITY.md` §7：
**允许** UI label / 气泡 / 转录 / 导出 / legacy 唯一精确匹配；**禁止** self-other 判定、
participant authority、visibility authority、**ownership**、permission。

---

## 1. 发现的问题

| # | 问题 | 严重性 |
|---|---|---|
| **P1** | `_chatWithdrawSelf` 用 `String(x.senderName||'')===String(senderName||'')` 选撤回目标。群聊**可达**（`_applyWithdraw` 在群成员回合内被调用）：两个角色同名时，A 的 `<withdraw/>` 会命中 **B** 的消息 | 高（跨角色改写他人 canonical 行） |
| **P2** | `_maybePatWithdraw` 用 `x.senderName === cur.senderName` 找"上一条同发送者"，同样是名字判等（调用点只在单聊，风险较低但同类） | 中 |
| **P3** | 群成员身份退化（`_gMember === null` ⇒ 退回无 P24 身份的单条构造）**完全静默**：既有 fallback 语义本身是设计，但运行期无法得知"身份丢了"与"本来就没有身份" | 低（可观测性缺口，非行为缺陷） |

---

## 2. 修改文件

| 文件 | 类型 | 内容 |
|---|---|---|
| `assets/js/communication.js` | production（唯一） | ① `_chatWithdrawSelf` 改走 canonical 判定（新增可选 `participants` 形参）；② `_applyWithdraw` 透传 `participants`；③ 群聊调用点传入本轮已有的 `_gParticipants`；④ `_maybePatWithdraw` 同款判定；⑤ 身份退化诊断面（计数 + 闭集日志 + 只读快照） |
| `tests/test_identity_read_path_closure.js` | 新增测试 | I1–I6（纯契约 + 源码守卫 + 真实浏览器 E2E） |
| `tests/test-all.js` | 仅登记 | browser 组新增一条（含注释说明） |
| `docs/P29-0-IDENTITY-READ-PATH-CLOSURE.md` | 新增文档 | 本报告 |

**未修改**：`group-runtime-core.js`、planner、targeting、recent、policy、P23、Memory、Middle Brain、
schema（`DB_VER` 仍 24）、任何域 canonical writer、任何 UI。Phase 1 的禁止清单逐条未触碰。

---

## 3. 为什么这是 identity bug

身份体系的分工是**单向**的：

```
canonical identity : speakerId / roleId / userId          → 可作判定
display identity   : senderName / displayName             → 只能展示
```

"这是不是我上一条消息"是 **ownership 判定**：它决定**改写哪一条 canonical 行**
（`_chatWithdrawMsg` 会把内容换成墓碑文案、清 images / wsSearches / memOps / voice）。
这类判定一旦由 `senderName` 承担，就会出现 M2 早已判定为**不可接受**的 false positive：

```
角色 A: id=friend_A, nickname="希儿"
角色 B: id=friend_B, nickname="希儿"
历史:   [B 的消息] [A 的消息]        两条的 senderName 都是 "希儿"
A 输出 <withdraw/>  ⇒  旧逻辑命中"最新的同名消息"
```

- 若 A 的最新同名消息其实是 B 的（A 只发过更早那条），A 就**改写了 B 的 canonical 行**；
- 用户看到的是"B 的消息被撤回"；B 的 persona / self-history / recent 派生随之失真；
- 这与 M2 冻结的不对称安全规则直接冲突：*"宁可少一条自己的旧话，也绝不把别人的话当成自己说过的"*。

因此它不是显示问题，而是**身份判定走错域**。

---

## 4. 修复方式

### 4.1 复用既有 resolver（不新建任何 matcher）

撤回目标的选择改为调用**已有**的 adapter：

```
_ibGroupClassifyMessage(message, currentSpeakerId, participants)   // communication.js 既有
  → IBGroupRuntime.classifyMessageForSpeaker → resolveSpeakerId    // group-runtime-core.js（M2 冻结）
```

判定语义（逐字沿用 M2，未改一行 core）：

| 情况 | 结果 |
|---|---|
| `metadata.speakerId` 存在且 = 当前角色 | `SELF`（撤回） |
| `metadata.speakerId` 存在但不等于当前角色（**即使 `senderName` 相同**） | `OTHER`（跳过）—— 这正是同名缺陷的修复点 |
| 无 `speakerId`（legacy）：显示名**唯一精确匹配** | `legacy` → `SELF` |
| 无 `speakerId` 且同名歧义 / 非法 / 非本群 / resolver 缺席 | `UNKNOWN` ⇒ **永不 SELF**（fail closed） |

### 4.2 participants 的来源（不新增 authority、不重读成员表）

| 场景 | participants | 理由 |
|---|---|---|
| 群聊 | 调用方透传本轮**已有的** `_gParticipants`（`groups.members` → `apiConfigs` 显示名，`:2361` 建立） | 不新增查询、不新建注册表 |
| 单聊 | `[{id: cfg.id, name: senderName}]`（省略参数时的默认） | 该会话的 assistant 行只可能属于当前角色 ⇒ legacy 名字回退在这里仍然是**唯一精确匹配**，历史行为不变 |

### 4.3 身份退化改为可诊断（不改语义）

`_gMember === null` 时新增：

- `_ibGroupIdentityDegraded('member-identity-unavailable' | 'group-identity-context-unavailable')`
  → 稳定计数 + 一行闭集日志（**不含**正文 / id / 昵称 / 凭据）；
- `window._ibGroupIdentityDegradedSnapshot()` 只读快照，供诊断与测试断言。

**不改**既有 fallback：仍然写"无 P24 身份"的 legacy 形状单条消息（M1 冻结语义），
**绝不**把诊断写进 `metadata` / DB / prompt（因此不是新字段、不是新 store）。

---

## 5. 测试结果

新增 `tests/test_identity_read_path_closure.js`（**54 checks 全绿**）：

| 组 | 覆盖 | 结果 |
|---|---|---|
| I1 | 同名群聊：A 只能撤回 A 的（`speakerId=A` 的 a1/a2）；同名 B 的行、`speakerId=B` 的行一律不动；每次调用恰好撤回 1 条；第三次调用返回 false | PASS |
| I2 | `speakerId` 优先：① 同名场景下 `speakerId` 生效；② `speakerId` 与 `config_id` 冲突时以 `speakerId` 为准；③ 自己的行即使 `senderName` 是别的名字也可撤回 | PASS |
| I3 | legacy 保持：单聊无 `speakerId`（`config_id` + 唯一显示名）**仍可撤回**（`_applyWithdraw` 返回清理后文本）；群聊同名 legacy 消息**永不**被判 SELF（fail closed） | PASS |
| I4 | 身份退化可诊断：注入 `createMemberIdentity → null` 后真实群回合仍产出 2 条回复、**无 P24 键**（fallback 语义不变）、诊断计数 ≥ 2、无诊断键泄漏进 canonical | PASS |
| I5 | 无新 authority：无 `IdentityManager` / `SpeakerAuthority` / `newIdentityResolver` / `speakerMatcher`；改动面零 `createObjectStore` / 零 `localStorage` / `_chatWithdrawSelf` 内零 `dbPut`；`DB_VER` 仍 24 | PASS |
| I6 | P24 不回归：`planVersion=3`、`plannerId=group-rule-v1`、SKIP reason 词表、`DYNAMIC_RUNTIME_DECISIONS`（speak/silent/defer）、`DYNAMIC_GATE_REASONS`、`pendingEntries.push(` 唯一、`memberTurnIdFor` 公式（与 `chat-core.stableToken` 逐字等值）、`planParticipation(_gPlanInput)` 恰好 1 次、core 身份函数各 1 份且无 `withdraw`/`_ibGroupIdentityDegraded` | PASS |

回归（相关套件，全部通过）：

| 套件 | 结果 |
|---|---|
| `test_group_turn_identity.js` | 99 PASS |
| `test_group_speaker_identity.js`（含真实浏览器同名 E2E） | 50 PASS |
| `test_group_dynamic_runtime.js`（STATIC/FOUNDATION 差分基线 + SILENT/DEFER） | 194 PASS |
| `test_group_explicit_targeting.js` | 72 PASS |
| `test_group_targeting_history.js` | 56 PASS |
| `test_group_runtime_trace_binding.js` | PASS |
| `test_group_turn_cancellation.js` | 35 PASS |
| `test_group_participation_integration.js` | 122 PASS |
| `test_group_participation_planner.js` | 109 PASS |
| `test_group_participation_policy.js` | 59 PASS |
| `test_group_recent_speakers.js` | 43 PASS |
| `test_group_participation_policy_integration.js` | 48 PASS |
| `test_group_participation_policy_storage.js` | 101 PASS |
| `test_p28_1_runtime_boundary_freeze.js` | 15 PASS |
| `test_voice_message_lifecycle.js`（撤回清 voice 的生命周期原语） | 68 PASS |

**基线红（pre-existing，本阶段未触碰、不修）**：
`test_p11_2h_group_prompt_boundary.js` 在装配阶段中止（`ReferenceError: _ibAllocateCompressible is not defined`）——
该 harness 的沙箱注入表早于 P11-3X-C 的输入预算阶梯，未注入 `_ibAllocateCompressible`；
`git diff` 证明本阶段的改动**没有触碰** `_buildGroupChatContext` 或 `_ibAllocateCompressible`。
P27-CLOSURE §22 已把 `p11_2*` 登记为**既有基线红**。

---

## 6. 未修改边界证明

| 边界 | 证据 |
|---|---|
| group-runtime-core.js | 本阶段零改动；I6 断言 core 内 `resolveSpeakerId` / `classifyMessageForSpeaker` / `memberTurnIdFor` / `planParticipation` 各恰好 1 份，且无 `withdraw` / `_ibGroupIdentityDegraded` 符号 |
| planner / planVersion / reason 词表 | I6 源码断言 + `test_group_participation_planner.js` 109 PASS |
| memberTurnId | I6 逐字等值断言（`memberTurnIdFor(g,sp,0) === 'turn_'+ChatCore.stableToken(g+':'+sp+':0')`）+ `test_group_turn_identity.js` 99 PASS |
| targeting / recent | 本阶段未触碰；`test_group_explicit_targeting.js` 72 PASS、`test_group_targeting_history.js` 56 PASS、`test_group_recent_speakers.js` 43 PASS |
| cap / 动态词表 | I6 断言闭集不变 + `test_group_dynamic_runtime.js` 194 PASS |
| DB schema / writer | 改动面零 `createObjectStore` / 零新 store；`DB_VER=24`；`_chatWithdrawSelf` 内无 `dbPut`（写点仍只有既有的 `_chatWithdrawMsg`） |
| P23 / P28 runtime 边界 | `test_p28_1_runtime_boundary_freeze.js` F1–F15 全 PASS（F11 P23 交付所有权、F12 P24 群参与所有权） |
| 单聊路径 | E2E 断言单聊 `byFriend=A_ID` 的行不含 P24 键；legacy 单聊撤回仍可用 |

---

## 7. 是否仍存在 senderName identity 使用

修复后，`communication.js` 中**可执行的** `senderName ===` 比较只剩 1 处，且是显示用途：

| 剩余使用 | 类别 | 说明 |
|---|---|---|
| `:378` `_getApiAvatarByName` | **display**（允许） | 头像查找（find-first）。同名群里可能取到第一个匹配角色的头像 —— 是显示瑕疵，不是身份判定；若要修，应改用 `metadata.speakerId`，属独立阶段 |
| `_messageApiConfig` 的 `senderName` 末位分支 | legacy 读取（允许） | 只服务无 canonical 键的旧消息；消费者是 `_messageShowThinking`（display） |
| M2 resolver 内的 legacy 名字分支 | 契约允许 | 仅当 `metadata.speakerId` 缺失，且要求**唯一精确匹配**，歧义 fail closed（M2 冻结语义） |
| 标签 / 气泡 / 转录 / 墓碑文案 / 导出 / 广播 / typing 文案 | **display**（允许） | M2 §7 明确允许 |
| `_chatShouldWithdraw(content)` 的 `@名字` 解析 | 文本启发式 | 判定对象是**正文文本**，不是消息身份；目标选择已由 canonical 判定承担 |

**仍存在的一处非 display 残留（本阶段未改，需独立阶段）**：

| 位置 | 判据 | 影响 | 为什么不在 P29-0 修 |
|---|---|---|---|
| `:1847` `_gInjMine(it) → it.actor === selfName` | 显示名等值 | workspace 读取/操作结果的**注入归属**：同名成员的 ws 结果会互相可见（attribution，不是 permission / ownership，不会改写他人消息） | 修它需要给 workspace op 建立 canonical **actor 身份**（`_execWsOps` 目前以显示名标注 actor）——那是**新的契约面**，本阶段明确禁止扩展架构 |

结论：**canonical decision path（权限 / self / ownership / withdraw）已完整闭合**；
剩余的 `senderName` 使用全部落在 display 与 legacy 读取两类允许用途，另有 1 处 attribution 归属残留已登记待独立阶段处理。

---

## 8. 停止条件检查

| 停止条件 | 是否触发 |
|---|---|
| 需要修改 P24 identity contract | **否**（复用 M2 冻结 resolver，core 零改动） |
| 需要修改 `memberTurnId` | **否** |
| 需要修改 planner | **否** |
| 需要修改 DB schema | **否**（`DB_VER=24`，零新 store） |

⇒ 本阶段在授权边界内完成，无需停止。
