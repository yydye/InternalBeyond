# P24-M3.1 · Participation Contract + Deterministic Rule Planner

阶段性质：**纯模块实现**（contract + deterministic rule planner）。
本阶段**不接管生产**：`communication.js` 的 `speakingCfgs` 过滤与 `for(const cfg of speakingCfgs)`
循环**逐字未改**；planner 已存在、已测试、contract 已冻结，但 production integration 属 **M3.2**。

状态：`PASS`。

---

## 1. Planner authority

```
Participation Planner 只回答：WHO GETS A MEMBER TURN（谁获得一次成员回合）
```

它**不是**：

| 不是 | 说明 | 归属 |
|---|---|---|
| Group Brain | 不做模型判断、不产 advisory hint | P25 |
| Delivery | 不产 timing / queue / typing / sequence | P23 |
| Storage | 不写库、不建消息、不建 system 行 | — |
| Identity | 不解析昵称 / `@` 文本；participant id 由调用方给 | 集成层（M3.2） |
| Capability executor | 不执行 Moments / Diary / Cinema / Memory / Economy | P25 |

文件位置：**继续使用 `assets/js/group-runtime-core.js`**（不新增第二个 group runtime authority）。
理由：本阶段新增的函数集很小（校验 + 规则表 + 输出构造），与 M1/M2 的身份层同属"群运行时核心"；
放在同一文件也避免修改 `InternalBeyond.html` 的脚本清单（HTML 是多 batch 共享文件）。

---

## 2. Input contract

```js
planParticipation({
  groupTurnId: 'gturn_<token>',              // 必须；M1 身份形状
  trigger: {
    userMessageId: 'msg_<...>',              // 必须；canonical user message id
    text: '<用户正文>'                        // 可选；**被校验但绝不参与规则判定**
  },
  participants: [                            // 必须（可为空数组 ⇒ 合法空 plan）
    { id: '<apiConfigs.id>', status: 'active'|'muted'|'removed', mentioned: true|false }
  ]
  // maxResponders?: <non-negative finite integer> | null
  //                         // P24-M3.3.2：undefined/null = 无上限；0 = 零发言人；
  //                         // 非负有限整数以外的一切值 ⇒ fail closed（bad-max-responders）
  // history?: [...]                        // 契约预留：M3.1 **不读**它（见 §8）
})
```

规则：

- `participants[].id` 必须是 **canonical `apiConfigs.id`**（空 / null / `group_*` / 控制字符 / 凭据形态 ⇒ fail closed）。
- `mentioned` 必须**已经是** canonical 布尔（由集成层把"用户点名"解析成 participant id 后给出）。
  **planner 不知道 nickname / senderName / displayName / model name**，也绝不 `text.includes('@'+nickname)`。
- `status` 是闭集：`active | muted | removed`。缺失 / 未知一律 **fail closed**（不 normalize 成 active）。
- 同一 `id` 出现两次 ⇒ validation failure（禁止 pick first / pick last / merge / 双 MemberTurn）。

### Mention identity boundary（集成层的责任）

```
raw text  →  canonical target resolution（M2 resolver）  →  participant id  →  mentioned = true
```

当前生产 mention 仍是 **nickname/model 子串匹配**（`communication.js` 的 `_ctxText.indexOf('@'+nm)`），
M3.0 已登记为 **M3 IDENTITY RISK**；M3.1 不改生产，但 contract 从第一天就是 canonical 布尔。
集成层若无法解析目标 ⇒ `mentioned=false`（**绝不猜一个 speaker**）。

---

## 3. Output contract（方案 C）

```js
{
  groupTurnId,
  plannerId: 'group-rule-v1',
  planVersion: 3,
  entries: [ { speakerId, decision: 'speak', order, reason } ],
  omitted: [ { speakerId, reason } ]
}
```

- `entries` **只放真正获得 MemberTurn 的 speaker**，`decision` 恒为 `'speak'`。
- 被跳过的成员**只**出现在 `omitted`（不出现 `decision:'skip'` 的 entry）——避免双重 authority。
- 输出键闭集：`groupTurnId / plannerId / planVersion / speakerId / decision / order / reason`。
- `plannerId` 与 `planVersion` 是**契约版本身份**，不从时间 / hash / 模型生成。

---

## 4. Decision vocabulary

| 值 | 位置 | M3.1 是否产出 |
|---|---|---|
| `speak` | `entries[].decision` | 恒定 |
| （skip） | 仅以 `omitted` 表达 | 是 |
| `defer` | — | 禁止（M3.4 以后） |
| `interject` | — | 禁止（M3.4 以后） |

---

## 5. Reason vocabulary（闭集）

| reason | 类别 | 何时产生 |
|---|---|---|
| `active-default` | SPEAK | `status==='active'` 且未被点名 |
| `mentioned` | SPEAK | `status==='active'`（点名不改变结果，但保留 runtime fact）或 `muted` 且 `mentioned===true` |
| `muted-not-mentioned` | OMITTED | `status==='muted'` 且 `mentioned!==true` |
| `removed` | OMITTED | `status==='removed'`（**即使被点名**） |
| `budget-limit` | OMITTED | **eligible**，但因 responder budget（`maxResponders`）未获得 MemberTurn（P24-M3.3.2 起转正） |
| `no-config` | RESERVED | M3.1 **不产生**（无 `apiConfigs` 的成员在集成层之前就被过滤） |

禁止自由文本 reason。

---

## 6. Exact rule table（逐字等价于当前生产 `speakingCfgs`）

| status | mentioned | 结果 | reason | order |
|---|---|---|---|---|
| `removed` | 任意 | OMITTED | `removed` | 不占 |
| `muted` | `false` / 缺失 | OMITTED | `muted-not-mentioned` | 不占 |
| `muted` | `true` | SPEAK | `mentioned` | 按顺序分配 |
| `active` | `true` | SPEAK | `mentioned` | 按顺序分配 |
| `active` | `false` / 缺失 | SPEAK | `active-default` | 按顺序分配 |
| 其他 / 缺失 status | — | **contract error** | — | — |

空 `participants=[]` 与"全员被 skip"都是**合法空 plan**（`entries: []`，不是 error）。

---

## 7. groupOrder frozen semantics

```
order（= 未来写入 metadata.groupOrder 的值）= PLANNED PARTICIPANT ORDER
```

- 0 起，按 **participants 数组顺序**对 SPEAK 者递增；OMITTED 者**不占** order。
- 运行期失败**不会**重排：A(0) 失败 → canonical 消息可能是 `0,2`。**空洞合法**；
  禁止为了连续把 C 改成 1。
- 它不是 successful speaker order（后者丢失"谁本该在这里"的信息，且让同一输入产生两种结果）。

---

## 8. Determinism / immutability / purity

| 不变量 | 要求 |
|---|---|
| 同输入 ⇒ deep-equal plan | 100 次断言（`tests/test_group_participation_planner.js` H） |
| 无时钟 / 无随机 | 源码内无 `Date.now` `Math.random` `performance.now` `crypto.randomUUID` |
| 顺序来源 | 只有 `participants` 数组；不依赖对象键迭代顺序 |
| 不改 input | `deepFreeze(input)` 仍可规划；input 逐字不变 |
| 不复用对象 | 输出对象全部新建；改 plan 不影响 input |
| 无 history 依赖 | `history` 为预留字段，planner 源码里根本不出现它（V3 断言） |
| 无 trigger.text 依赖 | 改 `trigger.text`（含 `@某人`）plan 不变；planner 不解析 `@` |
| 纯模块 | 无 DOM / `document` / 存储 / `fetch` / provider / TTS / Delivery Runtime / 定时器 / Memory / MB / Moments / Diary / Cinema / Economy |

---

## 9. Silence semantics

```
SILENCE IS NOT A MESSAGE
```

- `omitted` 只是 **runtime plan information**；planner 不 `dbPut`、不建 chatMessage、不建 system 行、不建 hidden row。
- "无人回应"的**呈现**（气泡/提示）属 M3.2 adapter，不属 pure planner。
- 无 storage 依赖由源码断言（模块内无 `chatMessages` / `dbPut` / `appendChatBubble`）。

---

## 10. Empty-plan semantics

| 输入 | 结果 |
|---|---|
| `participants: []` | 合法空 plan（`entries: []`, `omitted: []`） |
| 全员 `removed` / `muted` 未点名 | 合法空 plan（`entries: []`, `omitted: [...]`） |
| input shape 非法（缺 `groupTurnId` / `trigger` / `participants`，或 status/id 非法） | **contract error**（`err.code='PARTICIPATION_CONTRACT'`，`err.errors=[稳定词表]`） |

---

## 11. Security / metadata safety

- 输出**绝不**携带 `trigger.text`、persona、memory、prompt、tool payload、凭据。
- 秘密探针**复用** `voice-message-core.findSecret`（不新建 sanitizer）；只探**结构性身份字段**
  （`groupTurnId` / `userMessageId` / participant `id`+`status`）——`trigger.text` 与 `history`
  是受限正文载体，不直接送进探针（否则用户正文会被误判），由"绝不进入 output"这条不变量兜住。
- 输出通过 `findSecret(plan) === ''` 断言。

---

## 12. P23 boundary

Planner 输出**禁止**：`sequenceIndex` / `sequenceTotal` / `turnId` / `voice` / `image` / `delay` /
`typing` / `typingDuration` / queue identity / 任何 delivery timing。

P23 五个核心模块（`delivery-planner` / `multimodal-delivery-policy` / `delivery-sequence-core` /
`delivery-runtime` / `voice-message-core`）**一行未改**。

---

## 13. Group Brain / Middle Brain boundary

```
Participation Planner（RULE-BASED / DETERMINISTIC / PURE）
   ↓ selected speaker
MemberTurn →（该成员的）Middle Brain / member cognition → Model → P23 Delivery
```

- M3.1 不实现 Group Brain；未来 Group Brain **只能**提供 advisory hints，不得替代 planner authority，
  也不得成为 message / delivery / participant storage authority。
- 不得"先对所有角色跑 Middle Brain 再决定谁说话"（token / 延迟 / 副作用 / trace / context 五项代价）；
  且群聊当前根本不调用 Middle Brain，本阶段也不需要。
- API 里**不预埋** `model` / `provider` / `prompt` / `temperature` / `reasoningEffort`。

---

## 14. M3.2 integration seam（handoff）

唯一插入点（M3.0 已确认，当前 `communication.js` 行号）：

```
2134-2146  speakingCfgs = memberCfgs.filter(...)   ← 由 planner 的 plan.entries 取代
2148-2149  invalidMembers 校验                     ← 改为校验 plan 的发言集合
2178-2185  "无人回应" 安全网                        ← 改为 plan 的 no-speakers outcome
2222       _gParticipants（M2，只读）              ← planner 可在其前后读取
2245       for(const cfg of speakingCfgs)          ← 改为遍历 plan；groupOrder 取自 entry.order
2252-2253  _gOrder 分配                            ← 由 entry.order 提供（planned order，空洞合法）
2256+      宿主 turn / context / model / P23 / canonical 写入  ← 完全不动
```

M3.2 必须先解决的集成输入：把当前 nickname 子串 mention 解析换成 **canonical target resolution**
（复用 M2 resolver）后再填 `mentioned`；否则 planner 的 canonical 语义与生产输入不一致。

---

## 15. 测试

`tests/test_group_participation_planner.js`（static 组，纯 Node）：49 项，覆盖 A–W：
active 默认 / active+mention / muted 两态 / removed 两态 / order / determinism ×100 /
duplicate / invalid status / invalid id / empty / all-skipped / immutability / 不复用对象 /
输出无正文 / 秘密探针 / 无禁用 API / 无 P23 字段 / 沉默不是消息 / legacy 等价 /
无 history 依赖 / 无 text 依赖。

---

# M3.2 · Production Integration（参与权威切换）

状态：已接入。`communication.js` 的**唯一**参与权威从 legacy `speakingCfgs` filter
切换为 `planParticipation()`；当时的 planner contract 未修改（`group-rule-v1` / `planVersion 1`）。
（M3.3.2 起 `planVersion` 升为 **2**：input schema 增加 `maxResponders`、reason 词表新增 `budget-limit`、budget 竞争下的选择语义 —— 见文末 "M3.3.2" 章节。）

## A. 生产权威 before / after

```
before : group.members → memberCfgs → speakingCfgs.filter(status + nickname 子串 @) → for(const cfg of speakingCfgs)
after  : group.members → memberCfgs → canonical participants(+status, +canonical mentioned)
                          → validateParticipationInput → planParticipation → plan.entries
                          → for(const entry of plan.entries) → cfg = memberCfgById.get(entry.speakerId)
```

- 旧 filter 与 `_ctxText.indexOf('@'+nm)` **已下线**（源码守卫断言：两者在生产里零命中）。
- `memberCfgById` 是 entry → cfg 的**精确 id** 映射；找不到 cfg ⇒ `group-participation-entry-unknown-speaker`（fail closed，不猜不跳）。

## B. Canonical mention resolution

新增 pure helper（仍在 `group-runtime-core.js`，与 planning **分属两步**）：

```js
resolveMentionTargets(text, candidates /* [{id,name}] 只来自当前群成员 */)
→ { targets:[speakerId], ambiguous:[displayToken], unresolved:[displayToken] }
```

| 语义 | 行为 |
|---|---|
| `@Name` / `＠Name`（行首、空白、标点、句中 CJK 之后均可） | 精确匹配当前群成员的显示名 |
| 显示名后必须是边界（空白 / 标点 / 行尾） | `@初音未来abc` 不命中「初音未来」 |
| 唯一匹配 | `targets += id`（**最终身份永远是 id**） |
| 0 匹配（含 `@初音` 这类部分 token、`@所有人`、未知名字） | `unresolved`，**不点名任何角色** |
| ≥2 匹配（同名角色） | `ambiguous`，**两个都不点名**（绝不 pick first） |
| `a@Name.com`（email 形状的 ASCII 局部串） | 不算 mention（防邮箱误判） |

`@所有人 / @all / @全体`：**仍然 NOT IMPLEMENTED**（不新增行为）。

## C. Fail-closed 策略（无 legacy 回退）

| 情形 | 行为 |
|---|---|
| `validateParticipationInput.ok !== true` | `group-participation-invalid-input`：**不调用任何成员模型**、不产生 assistant canonical 消息、保留已落库的 user 消息、给出非 canonical 的可理解提示（系统气泡 + toast + console 稳定码） |
| `planParticipation()` 意外抛错 | `group-participation-planner-exception`：同上 |
| entry 的 `speakerId` 找不到 cfg | `group-participation-entry-unknown-speaker`：同上 |

**禁止**回退 legacy `speakingCfgs`（双权威会重新引入 nickname 参与判定）。

## D. groupOrder / 空洞 / 失败

- `metadata.groupOrder` 与 `memberTurnIdFor(...)` 的 order 参数**都直接取 `entry.order`**（planned order）；
  循环里不再有 `_gOrder++`（planner 是唯一的计划顺序权威）。
- 运行期失败**不重排、不重编号**：A#0 成功后 B 失败、C 仍写 `groupOrder 2` → canonical 消息 0,2（空洞合法）。
- OMITTED 成员**不占** order。

## E. 与改动前等价的语义

- 参与结果：`active` 全选、`muted` 仅精确点名入选、`removed` 永不入选 —— 与旧规则表逐条等价（M3.1 `U` 组 + M3.2 真实 E2E 对照）。
- `invalidMembers` 守卫**只校验 plan.entries**：被 omitted 的成员 API 未就绪不阻塞整轮；任一**计划发言者**未就绪仍然整轮中止（与改动前同一产品行为）。
- `roundExtras`、context builder、provider 调用、Middle Brain、P23、typing、voice、memory、summary、工具执行、取消、timing **全部未改**。

### 已知行为差异（唯一一处，M3.2 刻意）

参与决策现在发生在 user 消息落库与 `groupTurnId` 建立**之后**（planner 必须拿到 `groupTurnId`）。
因此"计划发言者 API 未就绪"这一条 abort 从"落库前"变为"落库后"：user 消息会被保留，
但输入框文案已在更早一步清空（与 §14 要求的"保留已落库的 user message"一致）。
除此之外没有其它可观察差异。

## F. 未纳入本阶段

cancellation（M3 GAP 仍在）、budget/max-responders、explicit targeting、recent-speaker suppression、
DEFER / INTERJECT、Group Brain、typing 收敛、P23 delivery 迁移、群 memory ACL。

## G. 测试

`tests/test_group_participation_integration.js`（browser 组；纯 resolver 16 项 + 真实页面 44 项 = 60）：
resolver 1–16（exact / fullwidth / space / punctuation / EOM / CJK 前缀 / partial / same-name ambiguous /
unknown / removed 仍可解析但 planner omitted / muted 点名入选 / active 点名入选 / 无 @所有人 /
只搜当前群成员 / 改名后按当前显示名 / 不 pick first / email 形状不误判）；
integration A–S（Round1 仅 A,C；Round2 @B 后 A,B,C；groupOrder 来自 plan；运行期失败留空洞 0,2；
omitted 不占 order；同名 muted 对 @X ⇒ 零 provider 调用、零 assistant 行；partial 不误唤醒；
invalid-API 只卡计划发言者；validation/throw ⇒ fail closed 无 legacy 回退；单聊不受影响；
roundExtras 与 M1/M2 身份不变；provider 请求里没有 plan 字段污染）。

---

# M3.3.2 · Participation Budget Contract（contract v2）

状态：已实现（**capability only**）。`plannerId` 仍为 `group-rule-v1`，`planVersion` 升为 **2**
（input schema 增加 `maxResponders`、reason 词表新增 `budget-limit`、budget 竞争下的选择语义变化）。

## A. Input：`maxResponders`

| 取值 | 语义 |
|---|---|
| `undefined` / `null` / 缺失 | **unlimited**（= 现行为；输出与 v1 语义逐字等价） |
| `0` | zero responders（合法空计划） |
| 非负有限整数 `k` | 最多 k 位发言者 |
| `k >= eligible 数` | 与 unlimited 等价（不 reorder） |

**禁止隐式转换**：负数 / 小数 / 字符串 / `NaN` / `Infinity` / 布尔 / 对象 / 数组 ⇒
`validateParticipationInput().ok=false`（`bad-max-responders`）且 `planParticipation()` 抛 contract error（fail closed）。

## B. 两阶段规划

```
Phase A · ELIGIBILITY（与 M3.1/M3.2 逐字等价；不分配 order）
  removed                 → omitted('removed')
  muted 且未点名           → omitted('muted-not-mentioned')
  其余（active；muted+点名）→ eligibleCandidates（内部结构，绝不进入 output）

Phase B · BUDGET SELECTION
  cap == null                     → selection = eligibleCandidates（participant 顺序）
  eligibleCandidates.length <= cap → 同上（**没有真实竞争 ⇒ 绝不 reorder**）
  真实竞争（eligible > cap）        → selectionOrder = mentioned（participant 顺序）
                                     ++ unmentioned（participant 顺序）
                                     取前 cap；溢出者 → omitted('budget-limit')

输出：entries 的 order 在 selection 之后分配为 0..k-1；omitted 保持 **participant 输入顺序**。
```

## C. Mention priority（只在真实竞争时生效）

```
A active unmentioned / B active unmentioned / C active mentioned / D active mentioned, k=2
  → entries: C#0, D#1 ；omitted: A budget-limit, B budget-limit

A/B/C mentioned / D unmentioned, k=2
  → entries: A#0, B#1 ；omitted: C budget-limit, D budget-limit（mentioned 内部严格 participant 顺序）

A unmentioned / B mentioned, k=2（eligible=2 ≤ cap）
  → entries: A#0, B#1（**不 reorder**）
```

## D. groupOrder / omitted / k=0

- `entries[i].order = i` ⇒ budgeted plan 的 order 恒为 `0..k-1`；`omitted` **不占** order。
- 运行期失败仍允许 canonical `groupOrder` 空洞（不重编号）——budget 与 failure 的可区分性由
  `omitted('budget-limit')` 提供。
- `k=0` ⇒ **合法空计划**：eligible 全部 `budget-limit`；本就 skip 的成员保持自己的 reason；
  集成层复用既有"本轮无人回应"呈现（不是 validation failure）。
- `omitted` 顺序 = participant 输入顺序（最稳定；与 M3.1/M3.2 既有语义一致）。

## E. Runtime-only / production default

- plan 仍 **runtime-only**：不 `dbPut`、不进 message metadata、不建 system/hidden 消息（silence is not message）。
- **生产默认仍 unlimited**：`communication.js` 的 planner adapter **不传** `maxResponders`
  （源码守卫：production 里零 `maxResponders` / 零 `budget-limit`），因此现有群聊"所有 eligible 成员参与"的行为不变。
- **配置来源尚未接入**（不新增 `group.maxResponders` / `apiSettings` 键 / UI）；capability 与契约先行，
  取值来源与默认 cap 由后续阶段单独决定。
- **cancel 与 budget 权威分离**：cancel 属 GroupTurn lifecycle（M3.3.1），budget 属 planning；两者互不写对方状态。

---

# M3.3.3.1 · Recent Speaker Derivation（contract · capability only）

状态：**纯 helper 已实现**，但**生产未启用**（`communication.js` 零修改；adapter 从不调用它）。
`planParticipation` **未改**、`planVersion` 仍为 **2**、reason 词表不变、budget selection 不变。

## A. Helper contract

```js
deriveRecentSpeakerIds(history, participants, { window })
  → { recentSpeakerIds: [ speakerId, ... ] }      // **most-recent-first**

validateRecentSpeakerInput(history, participants, opts) → { ok, errors[] }
RECENT_SPEAKER_ERRORS = ['bad-history','bad-participants','bad-opts','bad-window']
```

- `history`：**canonical ordered group message snapshot**（已 `filterSealed` + `_ibOrderMessages`，oldest → newest）。helper **不读** DB / IndexedDB / DOM / localStorage / fetch / timer / 时钟 / 随机。
- `participants`：当前群参与者（`[{id}]` 或 id 字符串数组；复用 `normalizeParticipants`）。
- `window`：**非负有限整数**；单位 = **MemberTurn**（不是 message）。非法值（`-1`/`1.5`/`'2'`/`NaN`/`Infinity`/`true`/`{}`/`[]`/缺失）⇒ **fail closed**（抛 contract error，`bad-window`），不 normalize / 不 clamp / 不 parseInt。

## B. 可计数规则

| 消息 | 是否消耗 window |
|---|---|
| `role==='assistant'` 且身份 **resolved** 且属于当前 `participants` | ✅ 消耗 1 个 MemberTurn slot |
| `role==='user'`（含**当前**用户消息） | ❌ 忽略（不消耗、不进入 output） |
| `role==='system'`（成员加入/退出等事件） | ❌ 忽略 |
| UNKNOWN / unresolved / ambiguous（含 legacy 同名） | ❌ 忽略（绝不猜） |
| 非当前群 participant / 非法 id 形状 | ❌ 忽略 |

> 原因：`recentSpeakerIds` 的语义是"最近 N 个**当前群成员的有效发言回合**"；user/system/unknown 绝不能把真正的发言者挤出窗口。

## C. MemberTurn 单位与 dedupe key

```
① metadata.turnId                                        ← 首选（P23：同一 MemberTurn 的多条消息共享 turnId）
② metadata.groupTurnId + '\u0000' + resolvedSpeakerId     ← 仅当两者都存在（无 turnId 的旧数据）
③ message.id                                              ← legacy 退化：一条消息 = 一个 MemberTurn（允许）
```

- **multipart**（`sequenceIndex` 0/1/2）与**工具续轮**（同 `turnId`、`sequenceIndex++`）都只占 **1 个 slot**；
- **绝不**只用 `groupTurnId` 去重（同一 GroupTurn 含多个 speaker 的 MemberTurn）；
- **绝不**按 timestamp / senderName 猜 turn 边界。

## D. 顺序与去重

- `history` 是 **oldest → newest** ⇒ 扫描方向**从尾到头**（index 遍历，绝不 `sort`/`reverse`/`splice` 输入）；
- 输出 **most-recent-first**；同一 speaker 只出现一次，**保留最新位置**；
- 两层 dedupe 各司其职：MemberTurn dedupe（避免 multipart 重复占窗口）+ speaker dedupe（输出唯一）。

例子（`A(T1) B(T2) A(T3) C(T4)`）：`window=2 → [C, A]`；`window=3 → [C, A, B]`；`window=4 → [C, A, B]`（A 的旧回合仍消耗 slot，但输出去重）。

## E. 身份权威（沿用 M2）

- 只经 `resolveSpeakerId`：canonical `metadata.speakerId` 优先 → legacy **唯一精确显示名**回退 → 否则 unresolved；
- **注意（实测）**：M2 resolver **没有** `config_id` tier（只有 `speakerId` 与 legacy 唯一名）⇒ 只有 `config_id` 的消息是 unresolved，helper **不得**自行实现 `config_id` 回退；
- ambiguous（同名 legacy）一律丢弃；绝不 pick first。

## F. 边界

- **不是** eligibility authority / hard suppression / runtime filter；本阶段甚至不接 selection；
- **本子阶段不改 planner**：`planParticipation` 里不出现 `recentSpeakerIds`（该约束的**边界**在 planner 契约升级到 v3 时由契约本身取代 —— 见文末 v3 章节；helper 与 planner 仍然分离：planner 绝不调用 helper）；
- **不改生产**：`communication.js` 不调用 helper（production 仍"不知道" recent capability）；
- 未来启用时的 snapshot 纪律（Phase 0 审计结论）：**ONE CANONICAL SNAPSHOT PER GROUP TURN**（`_gSealTs`/`gMsgs` hoist 到 planner 之前，planner 派生与 prompt 复用同一个快照）。

---

# M3.3.3.2 · Recent Speaker Planner Contract v3（contract · capability only）

状态：**planner 契约已升级到 v3**（input 增加 `recentSpeakerIds`、budget 竞争下增加 recent-aware selection tiers）。
**生产仍未启用**：`communication.js` 零修改、adapter 不传 `recentSpeakerIds`、`planVersion` 不被 adapter 读取。

## A. Input v3

```js
planParticipation({
  groupTurnId, trigger:{ userMessageId, text },
  participants:[ {id,status,mentioned} ],
  maxResponders?,          // M3.3.2：undefined/null = unlimited
  recentSpeakerIds?        // M3.3.3.2：canonical participant ids（可选）
})
```

| 取值 | 语义 |
|---|---|
| 缺失 / `undefined` | 等价 `[]`（无 recent 信息） |
| `[]` | 合法（等价缺失） |
| **`null`** | **非法**（`bad-recent-speakers`）——这是数组契约，与 `maxResponders` 的 `null=unlimited` **不是**同一语义 |
| 非数组（string / object / number / boolean） | 非法 |
| 元素含 `''` / `null` / 数字 / 布尔 / 对象 / 数组 / **非本群 participant id** / 凭据形态 | 非法（fail closed） |
| `['a','a','b','a']` | **接受**；planner 内部归一去重（membership），保持首次出现顺序、**确定性** |

**身份边界**：planner **只验证 membership**（id 属于当前 participants），**不解析身份** —— 不调 `resolveSpeakerId`、不做 `senderName`/`config_id` 回退（那些属 `deriveRecentSpeakerIds` / adapter）。
新错误词：`PARTICIPATION_ERRORS += 'bad-recent-speakers'`；`planVersion: 2 → 3`；`plannerId` 仍是 `group-rule-v1`。

## B. Selection tiers（只在**真实竞争**时启用）

真实竞争 = `maxResponders !== null` **且** `eligibleCandidates.length > maxResponders`。此时：

```
tier1 = mentioned                      （含 mentioned + recent；用户显式点名**豁免** recent penalty）
tier2 = !mentioned && !recent          （fresh unmentioned）
tier3 = !mentioned && recent           （recent unmentioned）
selectionOrder = tier1 ++ tier2 ++ tier3
selected = selectionOrder.slice(0, maxResponders)
overflow → omitted('budget-limit')     （**不新增** recent 专用 reason）
```

- 每个 tier 内部**严格 participant input order**（**不**按 `recentSpeakerIds` 数组顺序重排 —— 该数组只提供 membership）；
- **无竞争 ⇒ 不 reorder**：`maxResponders` 缺失/`null`、或 `cap >= eligible` 时，recent 完全不影响输出（与无 recent 的输出**全等**，除 `planVersion`）；
- **eligibility 不受 recent 影响**：`removed` 仍 `removed`、`muted` 未点名仍 `muted-not-mentioned`、`muted+mentioned` 仍进 tier1；
- `k=0` ⇒ 合法空计划，全部 eligible 记 `budget-limit`（recent/fresh/mentioned 都不改变结果）；
- `order` 在 selection 之后分配（`entries[i].order = i`，0..k-1）；`omitted` 保持 participant 顺序；
- 运行期失败仍允许 canonical `groupOrder` 空洞（**不** runtime renumber）。

核心行为例子（§14）：

```
participants: A active unmentioned recent / B active unmentioned fresh / C active mentioned fresh, cap=2
  无 recent → entries C#0, A#1
  有 recent → entries C#0, B#1 ；omitted A:budget-limit
```

## C. Output 与边界

- 输出键闭集不变：`groupTurnId / plannerId / planVersion / entries / omitted`；**不含** `recentSpeakerIds` / `tier` / `fresh` / `priority` / `selectionScore` / `maxResponders` / `history`；
- reason 词表**不变**（SPEAK `active-default|mentioned`；SKIP `muted-not-mentioned|removed|budget-limit`；RESERVED `no-config`）——recent **没有**独立 omission reason；
- **budget 截断权威不变**：仍只发生在 `planParticipation()` 内（runtime 循环里没有任何 cap/recent 逻辑）；
- **cancel 边界不变**：recent 只在 planning；cancel 只在 GroupTurn lifecycle；互不读写对方状态；
- **`deriveRecentSpeakerIds` 未修改**（M3.3.3.1 contract 保持），planner **不调用**它；
- **生产默认行为逐字不变**（unlimited、无 reorder、无 recent）。

---

# M3.3.3.3 · Production Adapter（ONE CANONICAL SNAPSHOT PER GROUP TURN）

状态：**已接线**（production data path）。`plannerId` 仍 `group-rule-v1`、`planVersion` 仍 **3**、reason 词表不变。
**用户可见参与行为逐字不变**：生产仍 **unlimited**（adapter 不传预算上限）⇒ recent 只是"接好的能力"，
在没有真实 budget competition 时不改变参与者数量 / 顺序 / `groupOrder`。

## A. 生产链路（唯一快照）

```
userMsg dbPut
  → groupTurn identity（groupTurnId / GroupTurn runtime state = created）
  → _gSealTs = getChatSealTimestamp(groupId)
  → gMsgs    = filterSealed(_ibOrderMessages(await dbGetByIndex('chatMessages','byFriend',groupId)), _gSealTs)
  → deriveRecentSpeakerIds(gMsgs, memberCfgs.map(c=>c.id), { window: GROUP_RECENT_SPEAKER_WINDOW })
  → planParticipation({ groupTurnId, trigger, participants, recentSpeakerIds })   // 仍不传预算上限
  → history = _cacheStableSlice(gMsgs, gKeepCount)        // **同一个** gMsgs
  → MemberTurn loop（roundExtras 负责本轮可见性）
```

- **每个 GroupTurn 只读一次** `chatMessages/byFriend`：该 `gMsgs` 同时是 ① recent 派生输入 ② prompt history 来源。
  读两次会产生两份快照，使"planner 看到的历史"与"成员看到的历史"可能不一致；
- **时机**：晚于 `userMsg` dbPut（当前用户消息在快照内）且早于 MemberTurn loop（本轮 A/B/C 的回复**不会**回流进 recent）；
- **sealed / order / cache 语义不变**：仍是 `filterSealed(_ibOrderMessages(byFriend), _gSealTs)` + `_cacheStableSlice(gMsgs, gKeepCount)`；
- **每 GroupTurn**：`deriveRecentSpeakerIds` 恰好 1 次、`planParticipation` 恰好 1 次（一个 GroupTurn 只规划一次）。

## B. Recent window（临时 v1 adapter policy）

```js
const GROUP_RECENT_SPEAKER_WINDOW = 2;   // 单位 = MemberTurn（不是 message）
```

- 局部常量：**不进** storage / UI / `apiSettings` / `localStorage` / schema / planner output；
- 未来的 **Group Participation Policy** 应当接管这个值（含 settings 归属）；
- 故意**不复用**任何"按消息计数"的窗口常量（`DEFAULT_READ_GROUP_CHAT` / `glim.groupChatLimit` / `gss.keepCount`）——
  单位不同；同一成员回合的多条 canonical 消息（multipart / 工具续轮）只占 1 个 slot。

## C. 边界与失败策略

| 边界 | 规则 |
|---|---|
| current user | helper 忽略 `role!=='assistant'` ⇒ 当前用户**永不**进入 recent；快照里只作为一条 user 消息（tail 上下文挂在这条上，不产生第二条 user） |
| 本轮回复 | 快照冻结在本轮开始前 ⇒ 本轮 A 的回复只能经 `roundExtras` 进入 B/C 的上下文 |
| 参与者身份 | 只传 canonical id，且与 planner 的 `participants` **同源**（同一批 `memberCfgs`）；绝不重读 `groups.members`、不建第二套 identity authority |
| 派生失败 | `deriveRecentSpeakerIds` 抛错（含 helper 缺席）⇒ 与 planner 失败同一路径：**GroupTurn planning fail closed**（不启动任何 MemberTurn、不产生 assistant 消息；user 消息保持已落库）。**绝不** fallback `recent=[]` 后继续 |
| budget | 生产仍不传预算上限；`budget-limit` / 截断逻辑只存在于 planner（runtime 循环零 cap 逻辑） |
| cancel | M3.3.1 语义零改：recent 属 planning，cancel 属 execution，互不读写对方状态 |
| P23 | 五核心零修改：recent 只决定 participation planning 输入，不碰 sequence / typing / voice / delivery queue / timing |
| 单聊 | 完全不走 group 分支：不读快照、不派生 recent、不规划（派生 / 规划调用数保持 0） |

---

# M3.4.1 · Policy Resolution Contract（pure · capability only）

状态：**已实现但未接线**（本阶段 production 零修改：`communication.js` / `social.js` / planner / recent helper / P23 全零改）。
`planVersion` 仍为 **3**、`plannerId` 仍为 `group-rule-v1`、reason 词表不变、`GROUP_RECENT_SPEAKER_WINDOW` 仍留在 `communication.js`。

## A. Authority（Phase 0 冻结）

```
group explicit  >  user default  >  system default      ← **逐字段**（不是整对象胜出）
```

- **Group 是 participation policy 的最终 owner**；user preference 只是"默认值来源"；system default 只是最终 fallback；
- role config（`apiConfigs`）**不是** policy authority；Middle Brain 只能建议、不能 override；Memory 不能影响 policy；Economy 本阶段完全不进入 resolver；
- runtime 不得裁剪 planner 结果，policy **只能影响 planning input**。

## B. Resolver 契约

```js
resolveParticipationPolicy(groupPolicy, userDefaults, systemDefaults)
  → { policy:{ maxResponders?, recentSpeakerWindow? },
      sources:{ maxResponders?: 'group'|'user'|'system', recentSpeakerWindow?: … } }

validateParticipationPolicyFragment(fragment) → { ok:boolean, errors:string[] }   // 不抛异常
```

**只吃已切出来的 fragment**（`{maxResponders?, recentSpeakerWindow?}`）：resolver 不认识 `groups` store / `apiSettings` / `localStorage` / MB / Memory / Economy 的形状 —— 那些属于 adapter。

错误词表（闭集）：`bad-fragment` / `unknown-field` / `bad-max-responders` / `bad-recent-speaker-window`；
resolver 遇非法输入抛 `PARTICIPATION_POLICY_CONTRACT`（`code` + `errors[]`，与 planner 的 validate + throwing resolver 同风格）。

## C. Allowed fields 与取值

| 字段 | 合法取值 | 说明 |
|---|---|---|
| `maxResponders` | 非负有限整数（`0` 合法 = 本轮无人回复） | **`null` 非法** —— 目标形态是"resolved explicit value"；用户选 Unlimited 应由 adapter **省略键**，而不是存 `null`（`null=unlimited` 只是 planner 的 wire-level 语义） |
| `recentSpeakerWindow` | 非负有限整数（`0` 合法 = 关闭） | 单位 = MemberTurn；不 clamp |

- 取值为 `-1` / `1.5` / `NaN` / `Infinity` / `'2'` / `true` / `{}` / `[]` / `null` ⇒ **fail closed**，绝不 normalize；
- **没有上限**：超大但有限的整数照样按原值接受（不 clamp）；
- `undefined` 字段 = 没有策略（不是 0）。

## D. Fragment 校验

- `undefined` = 合法（等价"没有策略"）；存在时必须是 **plain object**（`Object.prototype` 或 `null` prototype）；
- `null` / array / string / number / boolean ⇒ `bad-fragment`；
- **未知字段 ⇒ `unknown-field`（fail closed，绝不静默忽略）**：例如 `suppressionMode` / `mentionOverride` / `apiKey` 一律非法，错误信息**不回显**字段名与值；
- 扫描面 = **全部 own property**（含 non-enumerable）：校验与取值口径一致，隐藏字段既不能绕过校验、也不会被静默忽略；
- **inherited / prototype trick**（如 `Object.create({maxResponders:2})`）⇒ `bad-fragment`（prototype 非 `Object.prototype`/`null`）。`Object.create(null)` 合法。

## E. absence / 显式 0 / fail closed

- 三层都 `undefined` 或 `{}` ⇒ `{ policy:{}, sources:{} }`：**绝不物化** `maxResponders:null` 或 `recentSpeakerWindow:0`（absence 必须继续保持今天 production 的 semantics：capability 缺失 = unlimited）；
- 显式 `0` 是**真值**：`group{maxResponders:0}` 覆盖 `user{maxResponders:3}`（用 own-property 判定，禁止 `value || fallback`）；
- **fail closed means fail closed**：任意一层非法 ⇒ 整次解析失败，**绝不**回退到低优先层（否则"高优先层的错误配置"会被静默隐藏）；`group` 非法不会用 `user`，`user` 非法不会用 `system`。

## F. sources 与边界

- `sources` 是**诊断**（UI 展示 / 审计）：本模块只返回它，**不持久化**；未来也不得进 planner output / `chatMessages.metadata` / provider prompt / Memory / P23；
- 输出闭集：仅 `{ policy, sources }`，键只允许白名单字段；绝不返回 raw fragments；
- 纯：零存储 / 零网络 / 零 DOM / 零定时器 / 零随机 / 零时钟；输入不被修改（支持 `deepFreeze`），同 input ×100 结果全等；
- **与 planner 的关系**：resolver 是 planner 的**上游** —— 未来 adapter 先 resolve，再把具体值放进 planning input；planner 本体永不调用 resolver（因此本阶段不动 `planParticipation` / `planVersion`）。

## G. 本阶段完成 / 未完成

| 项 | 状态 |
|---|---|
| pure resolver + validator | ✅ 已实现（`assets/js/group-runtime-core.js`） |
| 测试 | ✅ `tests/test_group_participation_policy.js`（P1–P39） |
| production 接线 | ❌ 未接线（`communication.js` 零修改、零引用） |
| group settings / user settings / UI | ❌ 未新增（**Group Settings 未上线**） |
| `maxResponders` / recent suppression 生效 | ❌ 未启用（生产仍 unlimited） |

---

# M3.4.2 · Production Adapter（resolver 已接线 · 仍无 policy 来源）

状态：**resolver production-connected，但 NO POLICY SOURCE EXISTS YET**。
用户可见行为与 M3.4.1 之前**逐字一致**（`planVersion` 仍 3、`plannerId` 不变、生产仍 unlimited、window 仍 2）。

## A. 真实输入与默认结果

```js
const _gGroupPolicy = undefined;      // group policy storage 属 M3.4.3
const _gUserDefaults = undefined;     // user participation defaults 尚不存在
const _gSystemDefaults = undefined;   // system product defaults 尚不存在
const _gResolvedPolicy = _gCore.resolveParticipationPolicy(_gGroupPolicy, _gUserDefaults, _gSystemDefaults);
// ⇒ { policy:{}, sources:{} }      （absence：绝不物化默认值）
```

- 三个 fragment 都是 `undefined`（不是 `{}`，更不是伪造的 system default）：准确表达"**还没有任何 policy 来源**"；
- **`GROUP_RECENT_SPEAKER_WINDOW = 2` 仍是 temporary adapter fallback，不是 system policy** —— adapter 绝不用它去凑 `systemDefaults`；
- 生产 `maxResponders` 仍 **absent / unlimited**（planner input 里**没有**该自有键）。

## B. 执行顺序（每个 GroupTurn 恰好一次）

```
userMsg dbPut
  → groupTurn identity
  → canonical snapshot（chatMessages/byFriend 只读一次）
  → resolveParticipationPolicy(undefined, undefined, undefined)   ← 恰好 1 次，在 recent 派生之前
  → effective recent window（resolver 显式值优先，否则回落 adapter fallback = 2）
  → deriveRecentSpeakerIds(gMsgs, ids, { window: effective })     ← 恰好 1 次
  → build planner participants（mentions 不变）
  → planParticipation({ … , recentSpeakerIds, [cap 条件注入] })    ← 恰好 1 次
  → MemberTurn execution
```

**为什么 resolver 必须在 derive 之前**：`recentSpeakerWindow` 是 resolver 的字段之一。若先按 fallback 派生、再解析 policy，未来 storage 接入后 policy 的 window 将**永远无法生效**。

## C. 映射规则（逐字段，绝不整体透传）

| resolved 字段 | 去向 | 规则 |
|---|---|---|
| `maxResponders` | planner input | **条件注入**：`hasOwnProperty` 为真才写 `_gPlanInput.maxResponders`；否则**不产生该键**（absent ≠ "键存在但值为 undefined"）。**截断仍只由 planner 完成** |
| `recentSpeakerWindow` | `deriveRecentSpeakerIds` 的 `window` | **条件覆盖**：`hasOwnProperty` 为真才覆盖 fallback —— `0` 是"关闭 recent"的真值，禁止 `\|\|` 回退 |
| `sources` | 只作 runtime 局部量（**不外传**） | 不进 planner input / planner output / `chatMessages.metadata` / provider prompt / Memory / P23 / GroupTurn persisted state |
| 整个 `resolved.policy` | ❌ 绝不整体传给 planner | planner 只收到它**已支持**的具体值 |

`recentSpeakerWindow` **不是** planner input（它属于 adapter 的派生参数）。

## D. 失败路径

`resolveParticipationPolicy` 抛 `PARTICIPATION_POLICY_CONTRACT` ⇒ 与 participation planning **同级** fail closed：

- user canonical message 保持已落库；
- **deriveRecentSpeakerIds 不被调用**（resolver 在其上游）、planner 不被调用；
- 0 provider 调用、0 assistant canonical 消息；
- **不** fallback 成空 policy 后继续；**不**创建 system canonical error；
- 复用既有"本轮参与计划不可用"提示（无第二套 error authority）；
- GroupTurn 干净退出（后续回合仍能正常完成）。

## E. 未来形状预验证（adapter probes）

用最小 monkey-patch 让 resolver 返回假 policy（**不落任何 storage**）证明映射路径已就绪：

| 假 policy | 结果 |
|---|---|
| `{maxResponders:2}` | planner input 出现 cap=2；3 eligible → planner 裁到 2 planned → 2 次 provider 调用；`groupOrder` 0/1 |
| `{recentSpeakerWindow:0}` | `deriveRecentSpeakerIds(..., {window:0})` → `recentSpeakerIds=[]`；**不**裁人（仍 3 次调用） |
| `{maxResponders:0}` | planner 空计划 → 0 provider 调用、0 assistant 行、走既有"无人回应"呈现（**不是** runtime skip） |
| `{recentSpeakerWindow:5, maxResponders:2}` | window=5 且 cap=2 同时生效 |

## F. 本阶段未做

group policy storage（M3.4.3）、user participation defaults、system product defaults、UI、Economy ceiling、mention override、`planVersion` bump、`GROUP_RECENT_SPEAKER_WINDOW` 的替换 —— 全部**未做**。

---

# M3.4.3 · Group Policy Storage Contract（group-owned）

状态：**stored group policy 已可进入 production**（若数据存在）。默认用户行为不变（老群与新群默认都**没有** policy）。
`planVersion` 仍 3、resolver 契约零改、planner 零改、recent helper 零改、**无 UI**。

## A. Storage audit（Phase 0 结论）

| 问题 | 结论 |
|---|---|
| groups store 定义 | `core.js` `openDB()`：`createObjectStore('groups',{keyPath:'id'})` —— **只有 keyPath，没有字段级 schema** |
| create 路径 | `social.js confirmCreateGroup()` → `dbPut('groups',group)` |
| update 路径 | `social.js`：`setGroupMemberStatus` / `addGroupMember` / `removeGroupMember` / `_detachCharacterFromGroups` —— 都是"读整个 group → 改 → `dbPut('groups',group)`" |
| read 路径 | `social.js loadGroups()` = `dbGetAll('groups')`（整对象） |
| export/import | `core.js _ibBuildExportData()` 里 `groups: await loadGroups()`（整对象）；`importAll` 对 `data.groups` 逐个 `dbPut('groups',g)` —— **round-trip 保留未知字段** |
| Home Node | groups **不**在 Home Node（`services/**` 无 groups 引用）⇒ browser IndexedDB only |
| DB version | **24**（`core.js:3`，镜像 `chat-core.js:22`）；`groups` store 早已存在 |
| unknown field 是否保留 | ✅ 整对象读写 + structured clone；`normalizeGroupMembers` 只动 `members`/`mentionOnly`；无 whitelist/normalizer 会丢字段 |
| clone/duplicate group | **不存在**该功能（无需讨论 policy 随拷贝） |

**迁移决定：零 migration、零 DB bump**（object store 是 schemaless，新增字段不需要 schema 变更）。

## B. Canonical shape 与语义

```js
group.participationPolicy = { maxResponders?, recentSpeakerWindow? }   // 两个字段都可缺省
```

- **只有用户/未来 UI 显式配置至少一个字段时该键才存在**；绝不自动写 `participationPolicy:{}`、绝不物化默认对象、绝不 backfill 老群；
- `maxResponders` / `recentSpeakerWindow`：**非负有限整数**；`0` 是合法**显式值**（max=0 ⇒ 本轮无人回复；window=0 ⇒ 关闭 recent 偏好）；
- `null`、字符串、布尔、小数、`NaN`、`Infinity`、对象、数组、**未知字段** ⇒ **fail closed**（既不写入，也不"顺手剥离未知字段后写入"）；
- **清除语义**：清一个字段 ⇒ 该键消失；两个字段都没了 ⇒ **删除整个 `participationPolicy` 键**（不用 `null` 表示清理）。

## C. Authority 与原子性

- **唯一 validation authority** = `IBGroupRuntime.validateParticipationPolicyFragment`（core policy 契约）。storage 层**不**复制白名单/整数校验；
- **唯一 storage authority** = `social.js` 的
  `getGroupParticipationPolicy(group)` / `setGroupParticipationPolicy(gid,fragment)` / `clearGroupParticipationPolicy(gid[,field])`；
  没有第二套 store / cache / DB（`participationPolicyCache` / `participationPolicyStore` / `groupPolicyDB` 一律不存在）；
- **原子性**：先算 merged candidate → 校验通过才 `dbPut`；非法 update ⇒ 旧 stored policy **逐字不变**；
- **已存在的非法 stored policy**：写入与清除**都 fail closed**（`invalid-stored-policy`）—— storage 绝不静默修复非法高权威 policy；此时 production 也 fail closed（见 D）。

## D. Production read seam 与快照

```js
const _gGroupPolicy = group.participationPolicy;   // 用**已加载**的 canonical group object
const _gUserDefaults = undefined, _gSystemDefaults = undefined;
const _gResolvedPolicy = _gCore.resolveParticipationPolicy(_gGroupPolicy,_gUserDefaults,_gSystemDefaults);
```

- **不新增任何 policy DB 读**：`group` 对象本来就是本轮 `loadGroups()` 的结果；policy 不产生第二次 I/O；
- 字段缺失 ⇒ `undefined`（**绝不** `group.participationPolicy || {}`）；
- adapter 不做 validation：非法 stored policy 交给 resolver fail closed —— 走既有的"本轮参与计划不可用"路径（derive 与 planner 都不被调用、0 provider、0 assistant、user 消息保留）；
- **POLICY SNAPSHOT PER GROUP TURN**：每 GroupTurn 只 resolve 一次；若执行中途 policy 被改写，本回合**仍用旧值**，新 policy 下一回合生效；
- `sources` 仍只是诊断：不持久化、不进 planner、不进 metadata、不进 prompt、不进 Memory、不进 P23。

## E. 边界

| 边界 | 状态 |
|---|---|
| planner | 零修改；它**不读** group object；截断仍只发生在 planner |
| recent helper | 零修改；window = resolved 显式值 或 adapter fallback |
| user defaults / system defaults | **仍不存在**（`_gUserDefaults` / `_gSystemDefaults` 恒为 `undefined`） |
| `GROUP_RECENT_SPEAKER_WINDOW=2` | 仍是 **adapter fallback**，**不是** system policy |
| UI | 零 UI（HTML/CSS 未改；本阶段只提供 storage capability） |
| Economy / mention override | 未实现 |
| P23 | 五核心零引用 policy 存储 |

---

# M3.4.4 · Group Participation Settings UI（UI + canonical mutation adapter）

状态：**GROUP PARTICIPATION POLICY UI COMPLETE**。`communication.js` / `group-runtime-core.js` / P23 零修改，
`DB_VER` 仍 24；默认用户行为不变（未配置 = 不限制 / fallback 2）。

## A. UI audit（Phase 0 结论）

| 问题 | 结论 |
|---|---|
| 入口 | 成员管理弹窗 `#member-mgr-overlay`（`openMemberManager()`，social.js）；创建群时的 `#group-dialog-overlay` 只管创建 |
| 形态 | **modal overlay**（`.group-dialog-overlay.show`），340–420px |
| 现有可配置项 | 成员状态（Mute/Unmute/Remove 逐行按钮）、添加成员、搜索；创建弹窗内还有名称 / 成员 / 静默 / `memoryEnabled` / `thinkingEnabled` |
| 保存语义 | **即时保存**（点一下即写库 + toast + 重渲染），**没有** Save/Cancel |
| 现有构件 | `.group-dialog` + `label` + `input[type=text]` + `.group-api-list` + `.group-dialog-actions` + `.btn/.btn-primary` + `.member-mgr-item` |
| 数字输入 | 群弹窗内没有；API 设置页有数字输入；群弹窗已有 `<select>`（成员选择器） |
| inherit/default/unlimited | 之前**不存在**此类语义 |
| canonical group 来源 | 每次打开都 `loadGroups()`（`dbGetAll('groups')`）重新读；关闭重开重新读，无缓存 |
| 错误呈现 | `toast(...)`（本项目惯例） |

## B. Placement 与字段

- 位置：成员管理弹窗内新增 **section「群聊参与策略」**（不新建页面 / 不新建 policy 管理器 / 不塞进角色设置或 API 设置）；
- 字段：
  - **每轮最多回复角色**（`#group-policy-max`）：`不限制（未设置）` + `0..10`
  - **最近发言避让窗口**（`#group-policy-window`）：`不设置（当前行为：2）` + `0..10`
- 文案明确：window 只在**人数受限**（真实竞争）时才影响选择；未设置时"沿用当前行为（2）"——这是 **adapter fallback**，
  **不是** system policy / 系统默认；UI 也不会把它写进存储。

## C. 保存模型（即时保存 + 原子 desired state）

成员管理本来就是即时保存，participation policy **跟随同一模式**（不发明第二套交互）：

```js
// 每次 change：读两个下拉 → desired
desired = {};                       // 'unset' 表示键缺失（≠ 0）
if (max  显式) desired.maxResponders      = 值;
if (window 显式) desired.recentSpeakerWindow = 值;

if (desired 无 own key) await clearGroupParticipationPolicy(gid);        // 删除整个键
else                    await replaceGroupParticipationPolicy(gid, desired); // exact replace
```

**原子性**：一次 change = 一次 canonical 变更 = **恰好 1 次 `groups` 写**（不会"先 set max 再 set window"，
因此不存在 partial save）。UI 通过 monkey-patch 计数验证（U25）。

## D. Storage authority 扩展（新增 exact replace + 显式 reset）

```js
replaceGroupParticipationPolicy(gid, policy)   // undefined ⇒ 清空；{} ⇒ empty-fragment 拒绝；
                                               // 合法 fragment ⇒ 校验后**精确替换**（不是 merge）
resetGroupParticipationPolicy(gid)             // 显式、无条件删除整个键（含非法 stored policy）；
                                               // 无 policy 时幂等 no-op
```

- `setGroupParticipationPolicy`（patch/merge）与 `clearGroupParticipationPolicy(gid[,field])` 语义**未改**；
- `clear` 在 stored 非法时仍 fail closed（保留证据）；**只有**显式 `reset` 能删掉非法 policy（用户主动点击，
  **绝不**自动修复、绝不猜测非法内容）；
- 校验权威仍是 `IBGroupRuntime.validateParticipationPolicyFragment`：UI 只做"下拉 → desired"的解析，
  不复制白名单/整数校验（HTML 的 `min/step` 这类约束是 UX，不是 authority）。

## E. 非法输入与非法 stored policy

| 情形 | 行为 |
|---|---|
| 非法输入（`-1` / `1.5` / 文本）| **拒绝保存**（`invalid-policy`），不 clamp、不 `parseInt`、不改成 0；toast + 内联错误行（`aria-live`）；canonical 旧值不变 |
| stored policy 非法 | UI 显示「参与策略数据无效」+ 两个下拉 **disabled** + 「重置参与策略」；**不**自动修复、**不**把非法对象 hydrate 成数字 |
| 点「重置参与策略」 | `resetGroupParticipationPolicy(gid)` ⇒ 键消失 ⇒ UI 回到 `未设置/未设置`，下一轮 chat 恢复默认行为 |
| 打开设置但什么都不改 | **不**创建 `participationPolicy`（无 materialization） |

## F. 边界

| 边界 | 状态 |
|---|---|
| runtime（`communication.js`）| **零修改**（hash 与本阶段开始逐字相同） |
| core（`group-runtime-core.js`）| **零修改** |
| planner | 仍是唯一截断权威（UI 只写存储，不碰 runtime） |
| user defaults / system defaults | 仍未存在（UI 里没有"所有群默认"这类入口） |
| Economy / mention override | 未实现 |
| `GROUP_RECENT_SPEAKER_WINDOW=2` | 仍是 adapter fallback，不是 system policy |
| DB | `DB_VER` 仍 24；无新 store / cache |
| P23 | 五核心零引用 |
