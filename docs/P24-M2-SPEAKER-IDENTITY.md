# P24-M2 · Speaker Identity & Visibility Foundation

阶段目标（用户给定）：把群聊"这句话是谁说的"从 **senderName 字符串判等**（`senderName === selfName`）
迁移到 **canonical `metadata.speakerId`**，并建立一个极小的 visibility primitive。

本阶段实现的是：

```
IDENTITY READ PATH  +  VISIBILITY FOUNDATION（WHO SAID IT）
```

不是（明确不在本阶段）：

```
Participation Planner / Group Brain / silent / defer / interjection
visibility filtering policy（WHO MAY SEE IT）/ group memory ACL / group memory stamp
group summary redesign / P23 delivery migration / typing convergence
groups Home Node authority / Moments / Diary / Cinema / Economy / P25 orchestration
```

状态：`PASS`（见 §10 与 `tests/test_group_speaker_identity.js`）。

---

## 1. Canonical authority

| 层 | 字段 | 语义 | 权威性 |
|---|---|---|---|
| 身份（唯一权威） | `metadata.speakerId` = `apiConfigs.id` | 这条群消息是谁说的 | **canonical** |
| 身份（同源兼容） | `metadata.config_id` | M1 之前的群消息写入点（与 speakerId 同源） | canonical 兼容 |
| 展示 | `senderName` | 界面上写什么 / 转录标注 | **display only** |
| legacy 回退 | `senderName` 与参与者显示名的**唯一精确匹配** | 旧消息无 speakerId 时的读时解析 | legacy（不写回） |

写入侧（M1 已落地）：`metadata.speakerId` 只经 `delivery-sequence-core.buildMessages` 的
`extraMetadata` 进入 canonical message，禁止 dbPut 后补写。

读取侧（M2）：唯一入口是 `assets/js/group-runtime-core.js` 的
`resolveSpeakerId` / `classifyMessageForSpeaker`；`communication.js` 只做转调。

**participant authority 来源**（不新建注册表）：`groups.members` 的 id（`getGroupMemberIds`）
+ `apiConfigs` / `archivedConfigs` 的显示名。resolver 只**读**这两个 canonical 来源。

---

## 2. Resolver priority（唯一顺序，不做任何猜测）

```js
resolveSpeakerId(message, { participants })
→ { speakerId, source: 'metadata'|'legacy-exact-name'|'unresolved',
    confidence: 'canonical'|'legacy'|'none', reason }
```

1. `role === 'user'` ⇒ **不解析**（原因 `user-role`）。用户不是角色参与者，本阶段不发明 user identity。
2. `metadata.speakerId` 存在：
   - shape 非法（`group_` 前缀 / 控制字符 / 秘密形态）⇒ `invalid-speaker-id`（**不降级**到名字匹配）
   - 合法但不属于当前 participants ⇒ `speaker-not-a-participant`（同样不降级）
   - 合法且属于 ⇒ `source:'metadata'`, `confidence:'canonical'`
3. legacy（无 speakerId）：`senderName` 与 participants 显示名
   - 恰好 1 个匹配 ⇒ `legacy-exact-name` / `legacy`
   - 0 个匹配 ⇒ `legacy-no-match`
   - ≥2 个匹配（同名）⇒ `legacy-ambiguous`（fail closed）

**明确禁止**：pick first / 按 `groupOrder` 猜 / 按 `timestamp` 猜 / 按 `model` 猜 / 按数组位置猜。

`reason` 词表（稳定，供测试与 M3 使用；不含正文）：
`not-an-object` `user-role` `no-participants` `no-name` `legacy-no-match` `legacy-ambiguous`
`invalid-speaker-id` `speaker-not-a-participant`。

---

## 3. Visibility primitive

```js
classifyMessageForSpeaker(message, currentSpeakerId, participants)
→ 'USER' | 'SELF' | 'OTHER' | 'UNKNOWN'
```

| 结果 | 条件 |
|---|---|
| `USER` | `role === 'user'`（不做角色解析） |
| `SELF` | 解析出的 `speakerId === currentSpeakerId`（**只有这一条路**） |
| `OTHER` | 解析出 speakerId，但不是当前角色 |
| `UNKNOWN` | 无法解析：歧义 / 非法 / 不在群内 / 缺参与者 / `system` 行 / `currentSpeakerId` 为空 |

纯函数：不 build prompt、不查 Memory、不选参与者、不调模型、不改消息、不 fetch、不写库、不碰 DOM、
不读时钟。它只回答 **WHO SAID IT**，不回答 WHO MAY SEE IT。

---

## 4. Asymmetric safety rule（M2 frozen invariant）

```
UNKNOWN / ambiguous / invalid / legacy-collision  ⇒  永远不是 SELF
只有 resolved speakerId === currentSpeakerId 才是 SELF
```

- false negative（把自己的旧话当别人的）＝ 上下文略有损失，可接受；
- false positive（把别人的话当自己说的）＝ 污染 persona continuity / self-history / 推理 /
  未来 Group Brain，**不允许**。

退化路径同样遵守：`IBGroupRuntime` 未加载时 adapter 返回 `UNKNOWN`（绝不退回名字判等）。

---

## 5. Legacy compatibility

| 情形 | 结果 |
|---|---|
| 旧消息 + 群里只有一个该显示名的角色 | `legacy-exact-name` → 该角色（读时解析） |
| 旧消息 + 两个角色同名 | `unresolved`（`legacy-ambiguous`）→ OTHER/UNKNOWN |
| 旧消息 + 没有 senderName | `unresolved`（`no-name`） |
| `metadata.speakerId` 非法 / 不属于本群 | `unresolved`（不降级到名字） |

**No backfill**：绝不修改旧 `chatMessages`、绝不 `dbPut(updatedLegacyMessage)`、无 migration、
无 DB version bump。legacy 解析是**读时**行为，不产生持久副作用。

---

## 6. Same-name semantics

两个角色 `friend_A` / `friend_B` 都叫「初音未来」：

```
message 1: senderName=初音未来, metadata.speakerId=friend_A
message 2: senderName=初音未来, metadata.speakerId=friend_B

A 的视角：message 1 → SELF，message 2 → OTHER
B 的视角：message 1 → OTHER，message 2 → SELF
```

身份**完全**由 `speakerId` 决定；`senderName` 仍出现在转录标注里（`[初音未来] …`），
但它不再参与身份判定。

---

## 7. senderName boundary

**允许**：UI label / bubble display / transcript display / export 的人类可读名字 / legacy 唯一精确匹配。

**禁止**：self-other identity / participant authority / visibility authority / ownership。

生产读路径现状（M2 后）：

| 位置 | 用途 | 类别 |
|---|---|---|
| `communication.js` 群聊历史映射 | 经 `classifyMessageForSpeaker` 判定 SELF/OTHER | **canonical（speakerId）** |
| `communication.js _messageApiConfig` | speakerId → config_id → friendId → senderName 的**末位**回退 | legacy fallback |
| `communication.js _getApiAvatarByName` / 气泡 label / 撤回提示 | 头像、标签、通知文案 | display |
| `communication.js` 气泡续接分组、`social.js` 渲染续接 | 视觉分组 | display（同名时可能视觉合并，non-authoritative） |
| `workspace.js continueTruncatedMsg` | 经 `resolveSpeakerId` 决定"用哪个角色的模型续写" | **canonical（speakerId）** |
| `memory.js` 群聊转录标注（`:1589` / `:1866`） | 为记忆撰写者标注"谁说的"（人类可读转录行） | **deferred → M4**（见 §8） |

---

## 8. 已知边界（M2 不做但必须记录）

1. **memory.js 的群聊转录标注**仍是 `m.senderName || aiName`。它是"转录行的显示名"，
   不是 self/other/ownership 判定（后者已由本阶段迁移）；改动它需要在该 reader 里引入
   participant 名单与文案规则，属 group memory（M4）范围。留待 M4 与 group memory stamp 一起处理。
2. **同名 legacy 消息不可判定**（设计如此）：`legacy-ambiguous` → OTHER/UNKNOWN，绝不猜。
3. **视觉层的同名合并**（气泡续接分组）仍按 senderName；只影响外观，不影响身份、上下文、记忆。
4. **groupOrder 连续性**不在本阶段处理（失败成员可能占号，如 `0,2`）；resolver 不依赖它。
5. **groups 仍不进 Home Node 权威**（后续独立问题）。

---

## 9. M3 handoff

M3（Participation Planner）可以直接复用：

- `resolveSpeakerId` / `classifyMessageForSpeaker` 作为**唯一**的身份判定入口；
- `_ibGroupParticipants(memberIds)` 的参与者形状 `[{id,name}]`；
- 不对称安全规则（UNKNOWN 永不 SELF）作为规划与可见性判断的前置不变量；
- 本阶段的 `reason` 词表（歧义 / 非法 / 不在群）用于规划期诊断。

M3 需要自行定义（本阶段不做）：谁发言、顺序、沉默、defer、插话、关系驱动参与、
`groupOrder` 连续性语义，以及 WHO MAY SEE IT 层面的可见性过滤策略。

---

## 10. 测试

`tests/test_group_speaker_identity.js`（browser 组；先跑纯契约，再跑真实浏览器同名 E2E）：

- A–O 契约与边界：canonical 优先 / 同名区分 / legacy 唯一匹配 / legacy 歧义 fail closed /
  invalid / 非本群成员 / USER / tool continuation / UNKNOWN never SELF / no DB mutation /
  no migration / single chat unchanged / senderName 剩余读者审计；
- 真实浏览器同名 E2E：两个同名角色，检查**真正进入模型请求**的 context ——
  A 的发言在 B 的 prompt 里必须是 `user` 行（OTHER），B 自己的是 `assistant` 行（SELF）。
