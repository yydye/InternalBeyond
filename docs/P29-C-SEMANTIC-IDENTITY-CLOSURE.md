# P29-C Semantic Identity Closure
## Final Identity Decision-Surface Sweep & Closure Gate

阶段性质：**CLOSURE AUDIT / READ-ONLY FIRST / DISPOSITION-FREEZE**。
**ZERO PRODUCTION MUTATION**：本阶段没有修改任何 production 文件（唯一制品 = 本文档）；
临时探针写在仓库根并已删除（`git status` 无残留）。

---

## 1. State

**P29-C State: PASS WITH NOTES — P29 LOGICALLY FROZEN**

```
Closure blocker（§25 A–D）：0 条
新发现（本轮新扫描）：4 条（N1 blog 队列无 scope / N2 memory 转录标签 / N3 voice 名回退 display / R4-class '脚本' 写回标签）
剩余 debt 全部有 owner 与后续阶段名（§21 / §23）
```

---

## 2. Closure Definition

P29 的目标是 **B：关闭所有"已被证明会导致 identity semantic corruption"的路径**，
不是 A（修完所有 name-like 字段）。冻结判据（§24）逐条：

1. canonical ownership 路径不依赖 display identity —— ✔（§3）
2. canonical attribution 路径不依赖 ambiguous display identity —— ✔（§4）
3. 剩余 semantic-name risk 全部已分类 —— ✔（§5）
4. 无未分类的 HIGH confidence identity corruption —— ✔（本轮未发现 HIGH；见 §5/§18）
5. remaining debt 有 owner / future phase —— ✔（§21）
6. R2/R3/R4 不存在未处理的 closure blocker —— ✔（**不属于 §25 的 A/B/C/D 任一条**，理由见 §8–§10）
7. P24 / P23 / DB 冻结边界完好 —— ✔（§20/§21）

---

## 3. P29-0 Verification

| 检查 | 结果 | 证据 |
|---|---|---|
| `_chatWithdrawSelf` 是否仍用 display 作 ownership authority | **否** | `communication.js:5251-5266` 走 `_ibGroupClassifyMessage`（M2 resolver）；源码守卫 `A1/A3/A5` |
| `_maybePatWithdraw` 同上 | **否** | `communication.js:5197-5211` 同一判定 |
| canonical present ⇒ canonical wins | ✔ | 测试 `I2.speakerIdWinsOverSameName` / `I2.speakerIdWinsOverConfigIdAndName` |
| canonical mismatch ⇒ fail closed | ✔ | 同名 E2E（A 撤回只命中 A） |
| legacy ambiguity ⇒ fail closed | ✔ | `I3.legacyAmbiguousNeverSelf` |
| 是否出现新的旁路 | **未发现** | 全仓 `senderName ===` 可执行比较只剩 `_getApiAvatarByName`（display） |

复跑证据：`node tests/test_identity_read_path_closure.js` → **54 checks 全绿**（本阶段重新运行）。

---

## 4. P29-3 Verification

| 检查 | 结果 | 证据 |
|---|---|---|
| 四类 producer 是否完整透传 actorId | ✔ | read `_:441`；op-feedback `_:393/500/521/523/525/527`；run ctx `_:493` + push `run.js:204`；tool `site-operations.js:293/362/376/409/413` |
| 是否存在"producer 知道 cfg.id 却只写 actor"的新建条目 | **未发现** | `actor:authorName,actorId:actorId` 6 处 + run/tool/phantom 三路透传；守卫 `A1.*` |
| actor 是否仍为 display-only | ✔ | `A2.actorNeverReplacedById` + `A2.actorIdNotRenderedInFileUI` |
| reader 是否 canonical-first | ✔ | `communication.js:1868-1879`；`A5.readerCanonicalFirst` / `A5.readerNoDisplayFallbackAfterCanonicalMismatch` |
| 唯一 intentional 例外 | guard breaker 条目（§11） | `site-operations.js:316` |

复跑证据：`node tests/test_workspace_actor_identity.js` → **49 checks 全绿**（本阶段重新运行）。

---

## 5. Repository-wide Identity Sweep

扫描面：`assets / apps / active / services / bridge` 全部 `*.js`；关键词
`senderName` `displayName` `nickname` `name` `actor` `actorId` `author` `authorName` `selfName`
`lastModifiedBy` `createdBy` `owner` `ownerId` `speaker` `speakerId` `roleId` `friendId` `configId`，
以及 `=== name` / `!== name` / `includes(name)` / `find(...name...)` / `Map|Set key by name` /
`object[name]` / 名字路由 等模式。

| file:line | field | decision | class | reason | consumer | action |
|---|---|---|---|---|---|---|
| `communication.js:5251-5266` `_chatWithdrawSelf` | `metadata.speakerId`（M2 resolver） | OWNERSHIP / CANONICAL_MUTATION_TARGET | **SEMANTIC_SAFE** | canonical 优先；legacy 唯一名；歧义 fail closed | 撤回目标选择 | none（P29-0 冻结） |
| `communication.js:5197-5211` `_maybePatWithdraw` | 同上 | OWNERSHIP | **SEMANTIC_SAFE** | 同一判定 | "上一条同发送者" | none |
| `communication.js:1868-1879` `_gInjMine` | `item.actorId`（canonical） | ATTRIBUTION / PROMPT_VISIBILITY | **SEMANTIC_SAFE** | canonical wins；空 ⇒ legacy 唯一名；歧义 fail closed；无主 ⇒ 首轮兜底 | 群聊 workspace 注入 | none（P29-3 冻结） |
| `communication.js:2511` 群历史映射 | `metadata.speakerId` | SELF/OTHER | **SEMANTIC_SAFE** | M2 resolver | prompt 角色映射 | none |
| `communication.js:391-393` `_messageApiConfig` | `senderName`（末位） | DISPLAY（是否显示思考） | **DISPLAY_SAFE** | 仅无 canonical 键的旧消息；find-first 只影响显示 | `_messageShowThinking` | none（记录） |
| `communication.js:378` `_getApiAvatarByName` | `senderName` | DISPLAY | **DISPLAY_SAFE** | 头像；同名取首个匹配（cosmetic） | 头像 | none |
| `communication.js:5205` / `moments.js:596` `@名字` 解析 | 正文 token | 文本启发式 | **DISPLAY_SAFE** | 解析的是正文而非身份 | 自撤回触发 / 朋友圈自点名 | none |
| `bridge.js:787-798` `_ibGetCharVoice` | `dataset.senderId`（id 优先）→ nickname/model | RESOURCE_SELECTION（音色） | **LEGACY_SAFE** | canonical-first；名回退仅旧数据且只选音色 | TTS 音色 | none（记录；N3） |
| `social-observe.js:129-136` | `ev.actor` = **canonical roleId**（`_obsRec({actor:roleId})`） | 统计聚合键 / 方向矩阵 | **SEMANTIC_SAFE** | 生产侧写入的是 id（`moments.js` 多处 `actor:roleId`） | 观察统计 | none |
| `workspace.js:32` + `files.js:108/115/174` | `lastModifiedBy`（display） | FILE_OVERWRITE_DECISION | **SEMANTIC_RISK_CONFIRMED（窄）** | 仅"保留标签碰撞"（`User`/`你`/`导入`）会造成错误；同名 AI 不触发 | 导入/归档改名避让 + 文件 meta | **DEFER_TO_FILE_PROVENANCE（R4）** |
| `communication.js:1724` / `4450` | 无（take-all） | PROMPT_VISIBILITY / ROUTING | **SEMANTIC_RISK_CONFIRMED** | 无 actor / conversation 过滤；已实证跨会话 | 1:1 prompt / tool continuation | **DEFER_TO_NEW_SCOPE_CONTRACT（R2）** |
| `_ibImageDrain`（`site-operations.js:239` 声明；`workspace.js:390/462` 生产；`communication.js:2536/2950/4425` 消费） | **无任何身份** | 媒体附件（PROMPT_VISIBILITY） | **SEMANTIC_RISK_CONFIRMED** | 裸 dataUrl，无 attribution / 无 filter；已实证 | 视觉 prompt | **DEFER_TO_MEDIA_SCOPE（R3）** |
| `_ibToolDrainImages`（`site-operations.js:238/439`；消费 `2534/2948`） | 图片字节（来自被选中的 tool 结果） | 媒体附件 | **SEMANTIC_RISK_POTENTIAL** | 群聊侧继承 filter（安全）；1:1 侧 take-all ⇒ 继承 R2 | 视觉 prompt | 并入 R2 owner |
| `workspace.js:1095-1096/1192` `_blogPendingReads` / `_blogReadFeedback`（消费 `communication.js:1724/4450`） | **无任何身份** | PROMPT_VISIBILITY（**用户授权内容**） | **SEMANTIC_RISK_CONFIRMED（本轮新发现 N1）** | 模块全局队列 + take-all 消费者 ⇒ 用户在某会话授权的日志正文可进入**另一个角色**的 prompt | 1:1 prompt | **DEFER_WITH_OWNER（P30）** |
| `memory.js:1589/1866` 群聊转录标签 | `m.senderName` | PROVENANCE（写入 memory 正文） | **SEMANTIC_RISK_POTENTIAL（N2）** | 同名角色在记忆转录里标签相同；M2 §8 已显式 defer 到 M4 | 记忆文档（模型可见） | **DEFER_WITH_OWNER（M4 Group Memory）** |
| `site-operations.js:316` guard 熔断条目 | 无 | — | **INTENTIONALLY_UNATTRIBUTED** | 该路径作用域内**没有** author（见 §11） | 工具反馈 | 冻结为 intentional |
| `active-diary.js:837` `createdBy/createdByName` | roleId + 显示名 | PROVENANCE | **SEMANTIC_SAFE** | canonical id 与显示名成对存在 | 记忆派生 | none（正是 actorId 形态的先例） |
| `active-diary/diary.js:144` `createdBy:'ai'` | 种类标签 | PROVENANCE | **LEGACY_SAFE** | 身份由 `characterId` / `visibleTo` 承载 | 日记记忆 | none（记录混合字段） |
| `run.js:178` `wsSaveFile(...,'脚本')` | 系统标签 | PROVENANCE（persisted） | **SEMANTIC_RISK_POTENTIAL（R4-class）** | 脚本写回的文件丢失"哪个角色"，只留 `'脚本'` | 文件 meta / 导入避让 | 并入 R4 owner |
| `auto-memory.js:198-211` `_memoryApprovalQueue` | 无（UI 批准流） | 非 identity 路径 | **DISPLAY_SAFE** | 用户决策面板；写入时按捕获的 `cfg` 校验 `friendId` | 审批弹窗 | none（§15：UI 队列不算 identity bug） |

**判读规则（本轮遵守）**：纯 UI label / avatar / typing / export / toast / logging / transcript label
默认 DISPLAY_SAFE；只有当 display 值进入 SELF / OWNERSHIP / ATTRIBUTION / PERMISSION / ROUTING /
PROMPT_VISIBILITY / CANONICAL_MUTATION_TARGET / FILE_OVERWRITE_DECISION 时才升级分类。

---

## 6. Canonical Precedence

同时存在 canonical + display 的四处，逐一确认"canonical present ⇒ display 无 semantic authority"：

| 位置 | canonical | display | 结论 |
|---|---|---|---|
| `_gInjMine`（P29-3） | `actorId` | `actor` | ✔ canonical mismatch **直接 return false**，无 display 回退（`A5.readerNoDisplayFallbackAfterCanonicalMismatch`） |
| `_chatWithdrawSelf` / `_maybePatWithdraw`（P29-0） | `metadata.speakerId` | `senderName` | ✔ resolver 内部：speakerId 存在则只看 id |
| `_messageApiConfig` | `speakerId` → `config_id` → `friendId` | `senderName` | ✔ 名字是**末位**回退，且消费者是 display |
| `metadata.speakerId` + `senderName`（聊天消息） | id | 名字 | ✔ M2 冻结路径（群历史映射） |

**未发现** "canonical mismatch → display fallback → match" 的任何实例。

---

## 7. Legacy Fallback

所有 display-name legacy fallback（共 5 处）逐条对照 §10 五条件：

| 位置 | ① 仅 canonical absent 才进入 | ② exact | ③ unique | ④ ambiguity fail closed | ⑤ invalid fail closed |
|---|---|---|---|---|---|
| M2 `resolveSpeakerId`（core） | ✔ | ✔ | ✔ | ✔ | ✔ |
| `_gInjMine` legacy 分支 | ✔ | ✔ | ✔ | ✔（`_hits>1 ⇒ false`） | ✔（无匹配 ⇒ 无主兜底，不当作身份） |
| `_chatWithdrawSelf` 单聊默认 participants | ✔ | ✔ | ✔（单参与者天然唯一） | n/a | ✔ |
| `_messageApiConfig` 名字回退 | ✔ | ✔ | ✘（**find-first**） | ✘ | ✘ |
| `bridge.js:_ibGetCharVoice` 名字回退 | ✔ | ✔ | ✘（find-first） | ✘ | ✘ |

后两处不满足 ③④⑤，但**消费者是 display**（是否显示思考 / 音色），不进入语义判定 ⇒
按 §4 的判读规则列入 **DISPLAY_SAFE / LEGACY_SAFE**，并在 §21 记为"若要追求 100% 纯度的可选清理项"，
本阶段**不修**（§27）。

---

## 8. R2 — Take-all（1:1 context / tool continuation）

| 问题 | 回答 |
|---|---|
| Q1 是否仍可真实复现（P29-3 之后） | **是**（本轮探针）：B 在群聊语境产生的 workspace 条目（真实 producer，`actorId=friend_p29c_b`）被 **1:1 会话（角色 C）** 消费并注入其 prompt（`C_saw_B_group_item=true`，队列随后归零） |
| Q2 污染单位 | **global browser runtime queue → 跨 conversation（并跨 role）**；队列无 friendId/threadId/groupId 字段 |
| Q3 会造成什么 | **prompt contamination（confirmed）**；tool result misrouting（同机制）；**不**造成 canonical mutation；**不**造成 permission bypass（无授权由它决定） |
| Q4 是否 closure blocker | **否**（§25 B 要求"可在**现有 identity contract 内**最小修复"；R2 的最小修复需要会话维度，属 §25 明确列出的"不自动阻塞"项） |
| Q5 最小修复 | **conversationId/threadId**（不是 actorId） |
| Q6 只用 actorId 能否解决 | **不能**。反例：角色 A 在群聊产生的条目，其 `actorId` 与 A 的 1:1 会话相同 ⇒ actorId 过滤会把它放进 A 的 1:1 prompt（role 对、conversation 错）。同一角色可存在多个 conversation/thread，**actorId ≠ conversation identity** |
| Q7 是否必然引入新契约 | **是**（queue item 增加会话归属 + 全部注入点按会话过滤 + 无归属 legacy 条目处置） |
| 处置 | **DEFER_TO_NEW_SCOPE_CONTRACT** → **P30 · Workspace Conversation Scope** |

---

## 9. R3 — `_ibImageDrain`

| 问题 | 回答 |
|---|---|
| shape 现状 | **仍是裸 `dataUrl` 字符串**（`site-operations.js:239` 声明；`workspace.js:390` gen_image / `:462` read_image 生产；`communication.js:2536/2950/4425` 消费） |
| Q8 是否存在真实跨角色/跨会话污染 | **是**（本轮探针，真实 producer `ws_read_image`）：① 1:1（角色 C）请求里出现 B 产出的图片（`C_requestHasImagePart=true`）；② 群聊回合里 **A 与 B 的请求都带上了 B 产出的图片**（`A_requestHasImagePart=true`，因 `sentImages` 在成员循环内复用 + drain 为 take-all） |
| Q9 是否有 producer 同时知道 cfg.id 与会话 id | `workspace.js:462`（read_image）知道 `cfg.id`（`_execWsOps` 的第 3 参）与 `ictx.friendId`；gen_image 路径同样有 `cfg`。**但当前两者都没写进 drain** |
| Q10 图片是否会被错误角色模型看到 | **是**（同上，视觉门控只要求该成员支持视觉） |
| Q11 是否可能写入错误 canonical message | **否**（图片只作为**请求附件**注入；canonical `aiMsg.images` 来自该成员自己的 `_wsCollectGenImages(_gwsR)`，不受 drain 影响） |
| Q12 是否必须升级为 `{dataUrl, actorId, …}` | 若只修 actor 维度：是；但 R3 同时跨会话 ⇒ 与 R2 同源，**光加 actorId 不够** |
| Q13 是否还需要 conversation identity | **是**（同一角色多会话时，仅 actorId 仍会跨会话） |
| Q14 identity contract 还是 media queue contract | **media queue contract**（队列形状是裸媒体字节，缺的是"媒体归属 + 作用域"，不是 canonical identity 的定义） |
| 处置 | **DEFER_TO_MEDIA_SCOPE** → 独立阶段 **Media Attribution / Queue Scope**（owner 与 P30 协作） |

---

## 10. R4 — `projectFiles.lastModifiedBy`

| 问题 | 回答 |
|---|---|
| 可能进入该字段的值 | `'User'` / `'你'`（用户）、`'导入'`（导入管线）、**角色昵称**（`wsSaveFile`/`wsEditFileContent` 的 author）、`'AI'`（缺省）、**`'脚本'`**（脚本写回，`run.js:178`）、归档块的 author |
| Q15 是否有真实错误案例 | **无证据**（无测试/日志/报告显示发生过；同名 AI 之间**不会**触发该分支） |
| Q16 角色昵称为 `User`/`你`/`导入` 时 | 该 AI 写入的文件被**误判为"用户手改"** ⇒ 后续重写触发 `_wsUniquePath()` **改名避让**（不是覆盖，也不会覆盖他人文件）；同时 `files.js:996` 把它显示成 `User` |
| Q17 性质 | **reserved-label collision**（不是 identity bug：判据里没有"谁是谁"，只有"是不是用户"这一种类标签）；可归入 **file provenance bug** |
| Q18 后果 | **错误改名（窄）** + **拒绝覆盖（窄）** + UI 显示错（窄）；**不会**"覆盖不该覆盖的文件"（该分支只会避让，不会多覆盖） |
| Q19 修复是否需要 persisted canonical actor id | 若要让文件溯源真正 canonical：需要（`projectFiles` 记录增加 canonical 字段）；若只修"保留标签碰撞"：用显式 kind 标签（`authorKind:'user'/'role'/'system'` 语义）即可，**不需要**把 actorId 推广到所有 persisted records |
| Q20 是否需要 DB migration | 只修标签碰撞 ⇒ **不需要**；若要 persisted canonical provenance ⇒ 需要（`DB_VER` 变更）——两者都**不在 P29 范围** |
| Q21 是否阻塞 P29 | **否**（§25："低证据 persisted provenance debt"不自动阻塞） |
| 处置 | **DEFER_TO_FILE_PROVENANCE** |

---

## 11. Intentionally Unattributed Items

| 位置 | 为什么没有 canonical actor | 分类 | fallback contract |
|---|---|---|---|
| `site-operations.js:316`（guard 熔断条目） | 该函数（`_ibGuardAllow`）只拿到 `op` 与 guard 结果，**作用域内没有 author/actorId**；熔断是"这次调用被拒"的事实，不是某个角色的产出 | **INTENTIONALLY_UNATTRIBUTED** | `actor:''` ⇒ `_gInjMine` 第三分支 ⇒ **本轮首个发言者兜底消费**（P29-2 冻结；测试 `A10`） |
| `_ibQueueToolResult` / `_ibExecToolOp` 省略第 5 参的调用点 | 只为旧调用形状/测试保留默认值 `''` | **INTENTIONALLY_UNATTRIBUTED（默认值语义）** | 同上 |
| `cfg` 非对象（测试/诊断入口，如 `_processWsResponse(text,'测试','p4a-json')`） | 这些入口本来就没有 cfg | **LEGACY**（等价"没有身份可用"） | `actorId=''` ⇒ legacy 解析；`_chatWithdrawSelf` 之外不涉及 ownership |

**禁止为了"完整率 100%"强行填 actorId** —— 本阶段确认并冻结上述三类。

---

## 12. Global Queues

模块全局队列清单（本轮扫描 `pending|queue|drain|results|outputs|feedback|images`）：

| 队列 | 位置 | 是否带身份 | 消费者 | 判定 |
|---|---|---|---|---|
| `_wsPendingReads` / `_wsPendingOpFeedback` / `_wsPendingRunOutputs` | `files.js:4/6` · `run.js:12` | **actorId（P29-3）** | 群聊按 `_gInjMine`；1:1/续轮 take-all | 群聊 **SEMANTIC_SAFE**；1:1/续轮 = R2 |
| `_ibToolPendingResults` | `site-operations.js:237` | **actorId（P29-3）** | 同上 | 同上 |
| `_ibImageDrain` / `_ibToolDrainImages` | `site-operations.js:238/239` | **无** | 图片注入（无 filter） | R3 |
| `_blogPendingReads` / `_blogReadFeedback` | `workspace.js:1095/1096` | **无** | `communication.js:1724/4450` | **N1（新）** |
| `_ibTtsQueue` | `bridge.js:731` | 无 | TTS 播放（呈现） | DISPLAY_SAFE（非语义路径） |
| `_memoryApprovalQueue` | `auto-memory.js:198` | 无（UI 批准） | 用户审批弹窗；写入按捕获的 cfg | DISPLAY_SAFE |
| P23 delivery queue | `delivery-runtime.js` | **按 friendId 隔离** | 交付 | SEMANTIC_SAFE（已被作用域） |

---

## 13. Prompt Visibility

"某个角色/用户产生的信息 → 另一个角色模型 prompt"的全部路径与 attribution authority：

| 路径 | authority | 判定 |
|---|---|---|
| 群聊 workspace 注入（read/feedback/run/tool） | **canonical**（`actorId`） | SEMANTIC_SAFE（P29-3） |
| 1:1 / tool-continuation 同四类注入 | **global/take-all** | **R2（confirmed）** |
| 图片回注（`_ibImageDrain` / `_ibToolDrainImages`） | **none**（无身份） | **R3（confirmed）** |
| 博客阅读回注（`_blogPendingReads`） | **none**（无身份） | **N1（confirmed，同 R2 机制）** |
| 群聊历史行 → prompt 角色映射 | **canonical**（`speakerId`，M2） | SEMANTIC_SAFE |
| `roundExtras`（本轮更早成员回复） | canonical（同轮同会话，按设计可见） | SEMANTIC_SAFE（intentional） |
| `recentSpeakerIds`（planner 输入） | canonical id | SEMANTIC_SAFE |
| Activity context（`getActivityContext`） | 按 `cfg.id` + thread 取 | SEMANTIC_SAFE |
| Memory 投影（`isMemoryVisibleTo`） | canonical（visibility/visibleTo/characterId） | SEMANTIC_SAFE |
| 群记忆转录标签 | display（`senderName`） | **N2（potential）** |

**结论**：prompt visibility 的三条缺陷全部是 **scope/媒体契约缺失**，不是 canonical identity 缺失。

---

## 14. Group Identity

| 面 | 现状 | 结论 |
|---|---|---|
| speaker ownership（撤回/拍一拍） | P29-0 canonical-first | ✔ |
| history SELF/OTHER | M2 resolver（`metadata.speakerId`） | ✔ |
| workspace attribution | P29-3 canonical-first（`actorId`） | ✔ |
| targeting（`targetSpeakerIds`） | 未改（P29-3 未触碰） | ✔ |
| recentSpeakerIds | 未改 | ✔ |
| planner order / planVersion=3 / plannerId | 未改 | ✔ |
| memberTurnIdFor | 未改（逐字等值断言） | ✔ |
| cap / SILENT / DEFER / 动态词表 | 未改 | ✔ |

---

## 15. 1:1 Identity

单聊**不因"没有同名成员"而安全**：本轮证据显示 1:1 是 R2/N1 的**受害者侧**（take-all 消费者）。

* 单聊内部不存在角色同名歧义（一个会话一个角色）✔；
* 但全局队列会把**别的会话/角色**的 workspace 结果、图片、用户授权的博客正文带进当前 1:1 prompt；
* 区分（§16）：**ROLE IDENTITY**（谁产的）已 canonical；**CONVERSATION IDENTITY**（属于哪个会话）**完全缺失**。

---

## 16. Actor Identity vs Conversation Scope

```
Actor Identity        ≠  Conversation Scope
（WHO produced it?）      （WHERE does it belong?）
  actorId / speakerId      friendId + threadId → chat-core.conversationIdOf
```

冻结条文：

1. `actorId` 只回答"谁产生的"，**不得**用它表达会话归属（同一角色多会话即反例，§8 Q6）；
2. 会话归属的既有真源是 `chat-core.conversationIdOf(friendId, threadId)`（P23 delivery runtime 已按 friendId 隔离，可作先例）；
3. R2 / R3 / N1 的剩余问题本质属于 **conversation/media scope** ⇒ **不要继续塞进 actorId**。

---

## 17. Persistence / Provenance

| 面 | 状态 | 说明 |
|---|---|---|
| workspace runtime actorId | **runtime-only**（P29-3） | 无持久化、无 schema |
| `projectFiles.lastModifiedBy` | persisted **display** | R4（§10）：reserved-label collision + provenance 缺 canonical |
| memory `createdBy` / `createdByName` / `characterId` | persisted（id + name 成对，或 kind 标签 + id） | SEMANTIC_SAFE / LEGACY_SAFE（§5） |
| chatMessages metadata（`speakerId` / `config_id` / P24 三键） | persisted canonical | 未改 |

**冻结**：不因为 runtime actorId 成功，就把 actorId 自动推广到所有 persisted records（§23 要求）。
每个 persisted contract 独立判断（目前只有 R4 需要，且留独立阶段）。

---

## 18. Closure Matrix

| Item | Evidence | Semantic Class | Severity | Reproducible | Contract Needed | Disposition | Blocks P29 |
|---|---|---|---|---|---|---|---|
| P29-0 withdraw ownership | `communication.js:5251-5266` + 54 checks | SEMANTIC_SAFE | — | 否定（已 fail closed） | none | FROZEN | No |
| P29-3 workspace actor attribution | `_gInjMine` + 四类 producer + 49 checks | SEMANTIC_SAFE | — | 否定 | none（P29-2 已冻结） | FROZEN | No |
| R2 take-all（1:1 / tool continuation） | 探针：B 的条目进入 C 的 1:1 prompt | SEMANTIC_RISK_CONFIRMED | **Medium** | **Yes** | conversation scope（非 actorId） | **DEFER_TO_NEW_SCOPE_CONTRACT**（P30） | **No**（§25 明列） |
| R3 image drain | 探针：B 的图片进入 C 的 1:1 / A 的群 prompt | SEMANTIC_RISK_CONFIRMED | **Medium** | **Yes** | media queue scope（+conversation） | **DEFER_TO_MEDIA_SCOPE** | **No** |
| R4 `lastModifiedBy` | `workspace.js:32` + `files.js:108/115/174` | SEMANTIC_RISK_CONFIRMED（窄） | **Low** | 仅保留标签碰撞（无实际案例） | persisted provenance / 标签 kind | **DEFER_TO_FILE_PROVENANCE** | **No** |
| guard breaker 无 actorId | `site-operations.js:316` | INTENTIONALLY_UNATTRIBUTED | — | — | none（首轮兜底已冻结） | **FROZEN as intentional** | No |
| **N1** `_blogPendingReads` 无 scope | `workspace.js:1095/1192` + 消费者 `1724/4450` | SEMANTIC_RISK_CONFIRMED（用户内容） | **Medium** | Yes（同 R2 机制） | conversation scope | **DEFER_WITH_OWNER**（P30） | No |
| **N2** memory 群转录标签 | `memory.js:1589/1866` | SEMANTIC_RISK_POTENTIAL | Low-Med | 原理可复现 | group-memory provenance（M2 §8 已 defer） | **DEFERRED_WITH_OWNER**（M4） | No |
| **N3** voice 名回退 | `bridge.js:791-793` | LEGACY_SAFE（display/音色） | Low（cosmetic） | Yes（挑错音色） | none | ACCEPTED_DEBT | No |
| **N4** `_messageApiConfig` find-first | `communication.js:391-393` | DISPLAY_SAFE | Low（显示） | Yes（显示思考开关） | none | ACCEPTED_DEBT | No |
| **N5** `actor` 词汇双语义 | workspace=display / moments+social-observe=canonical roleId | SEMANTIC_SAFE（各自契约成立） | — | — | 已在 P29-2 §5 冻结措辞 | FROZEN | No |
| **N6** R4-class：脚本写回标签 `'脚本'` | `run.js:178` | SEMANTIC_RISK_POTENTIAL | Low | 原理可复现 | persisted provenance | 并入 R4 owner | No |
| **N7** P23 delivery queue | 按 friendId 隔离 | SEMANTIC_SAFE | — | — | none | FROZEN | No |

---

## 19. Architecture Matrix

| Concern | Correct Identity Dimension | 仓库事实（调整后） |
|---|---|---|
| Who produced this result? | **actorId** | workspace runtime item（P29-3）；canonical = `cfg.id` |
| Which role spoke this message? | **speakerId** | `chatMessages.metadata.speakerId`（P24-M2），兼容 `config_id` |
| Which conversation owns this item? | **conversation identity** | **workspace/media/blog 队列当前没有该维度**（唯一真源 = `chat-core.conversationIdOf(friendId, threadId)`；P23 delivery runtime 是既有先例）→ R2/R3/N1 owner |
| Human-readable label | **actor / senderName / displayName / lastModifiedBy** | display-only（不得作 semantic decision） |
| Who last modified persisted file? | **独立 provenance contract** | 现状 = display 名 + 保留标签（`User`/`你`/`导入`/`脚本`）→ R4 owner |
| （补充）Who owns a media attachment? | media queue scope（当前 **none**） | R3 owner |

---

## 20. Tests / Probes

| 证据 | 命令 | 结果 |
|---|---|---|
| P29-3 identity suite（本阶段复跑） | `node tests/test_workspace_actor_identity.js` | **49 PASS** |
| P29-0 closure suite（本阶段复跑） | `node tests/test_identity_read_path_closure.js` | **54 PASS** |
| R2 复现探针（临时，已删） | 真实 `_execWsOps`（cfgB）→ 1:1 发消息给 C | `C_saw_B_group_item=true`；队列归零 |
| R3 复现探针（临时，已删） | 真实 `ws_read_image`（cfgB）→ 1:1 给 C / 群回合 | `C_requestHasImagePart=true`；群内 `A=true,B=true`；drain 形状仍为裸字符串 |
| 静态扫描 | 关键词 + 比较模式（§5） | 全仓覆盖，命中已全部归类 |

**未跑 full quick**（§26；本阶段 ZERO production mutation）。P29-3 阶段已跑过的 focused 回归
（`test_workspace_smoke` / `test_group_speaker_identity` / `test_group_turn_identity` /
`test_p11_3d_tool_execution_guard` / `test_image_router_smoke` / `test_moments_phase4_smoke`）仍有效。

---

## 21. Remaining Debt

| Debt | Owner（后续阶段） | 需要的契约 | 阻塞 P29 |
|---|---|---|---|
| R2 1:1 / tool continuation take-all | **P30 · Workspace Conversation Scope** | 队列会话归属 + 全部注入点过滤 + 无归属 legacy 处置 | No |
| N1 blog 阅读队列无 scope | **P30**（同一 owner） | 同上 | No |
| R3 `_ibImageDrain`（+`_ibToolDrainImages`） | **Media Attribution / Queue Scope** | 媒体队列归属（形状变更）+ 会话作用域 | No |
| R4 `projectFiles.lastModifiedBy`（+ `'脚本'` 写回） | **Workspace File Provenance** | persisted provenance / 保留标签 kind | No |
| N2 memory 群转录标签 | **M4 · Group Memory**（M2 §8 已指定） | group memory provenance | No |
| N3 voice 名回退、N4 `_messageApiConfig` find-first | P29 归档清理（可选，无 owner 强制） | 不需要语义契约 | No |

---

## 22. Freeze Decision

**P29 · Identity Closure**
**LOGICALLY FROZEN**

理由：§24 七条判据全部满足；§25 的四类 blocker（A–D）无一命中
（A：无跨角色 canonical mutation；B：剩余跨角色错配**不能**在现有 identity 契约内最小修复；
C：无"canonical 存在却被丢弃导致错误决策"的剩余路径；D：legacy ambiguity 全部 fail closed）。
剩余 R2/R3/R4 + N1/N2 已被 §25 明确划为"不自动阻塞"，并已指定 owner。

---

## 23. Next Stage Recommendation

1. **P30 · Workspace Conversation Scope**（首选）：一次性覆盖 R2 + N1 + 1:1 侧的 R3 派生队列；
   契约核心 = "队列条目带会话归属（`conversationId` 或 `friendId+threadId`）+ 注入点按会话过滤 +
   无归属 legacy 条目处置"。**不要**把它做成 identity 阶段（actorId 已经做完）。
2. **Media Attribution / Queue Scope**（并行或随后）：`_ibImageDrain` 形状与归属；
   与 P30 共享会话维度但独立于 identity。
3. **Workspace File Provenance**：`projectFiles.lastModifiedBy` 的语义与保留标签；
   若引入 canonical provenance 才涉及 schema 决策。
4. **M4 · Group Memory**：N2（记忆转录标签）并入既有 M4 计划。
5. **不做**：新 Authority / 新 Identity subsystem / Event Bus / Agent Runtime /
   把 actorId 推广到所有 persisted records。

---

## 24. Worktree / Commit Status

| 项 | 结果 |
|---|---|
| 本阶段 production mutation | **ZERO**（未修改任何 production 文件；两套 identity 套件复跑均为只读） |
| 新增制品 | `docs/P29-C-SEMANTIC-IDENTITY-CLOSURE.md`（本文档） |
| 临时探针 | `tmp_p29c_probe.js`（仓库根，运行后已删除；`git status` 无残留） |
| git 操作 | 未使用 `checkout --` / `restore` / `reset --hard` / `clean` / stash；未 stage、未 commit |
| 既有工作树 | 仍含 P11–P29 多批未提交改动（未触碰、未覆盖） |

---

## 附 · Required Final Questions（Q1–Q30）

1. **P29-0 ownership closure 是否仍成立？** 成立（`_chatWithdrawSelf` / `_maybePatWithdraw` 均 canonical-first；54 checks 复跑全绿）。
2. **P29-3 attribution closure 是否仍成立？** 成立（四类 item 带 `actorId`，reader canonical-first；49 checks 复跑全绿）。
3. **是否还有 display identity 直接决定 canonical ownership？** 没有。
4. **是否还有 display identity 直接决定 canonical actor attribution？** 没有（workspace 已 canonical；M2 路径 canonical）。
5. **是否还有 canonical-present → display fallback 的错误路径？** 没有（§6 四处逐一确认）。
6. **是否还有 legacy ambiguity 被当作 identity truth？** 没有（全部 fail closed；两处 find-first 仅用于 display）。
7. **R2 是否真实可复现？** 是（探针：B 的 workspace 条目进入角色 C 的 1:1 prompt）。
8. **R2 本质是 actor identity 还是 conversation scope？** conversation scope。
9. **actorId 能否单独解决 R2？** 不能（同一角色多会话 ⇒ 需要会话维度）。
10. **R2 是否阻塞 P29？** 不阻塞（§25 明列"conversation scope 缺失"不自动阻塞）。
11. **R3 是否真实可复现？** 是（探针：B 的图片进入 C 的 1:1 prompt，并进入同群 A 的 prompt）。
12. **R3 本质是 identity 还是 media queue scope？** media queue scope（队列连身份字段都没有）。
13. **R3 是否阻塞 P29？** 不阻塞（§25"media queue contract 缺失"不自动阻塞）。
14. **R4 是否有真实错误证据？** 无（仅保留标签碰撞的理论路径；同名 AI 不触发）。
15. **R4 本质是 identity 还是 persisted provenance？** persisted provenance（+ reserved-label collision）。
16. **R4 是否阻塞 P29？** 不阻塞（§25"低证据 persisted provenance debt"不自动阻塞）。
17. **guard breaker 无 actorId 是否为 intentional？** 是（该作用域没有 author；已冻结为 INTENTIONALLY_UNATTRIBUTED + 首轮兜底）。
18. **是否还有其它 intentionally unattributed item？** 有（`_ibQueueToolResult`/`_ibExecToolOp` 省略参数时的默认 `''`；非对象 cfg 的测试/诊断入口）。
19. **是否发现新的 HIGH severity identity corruption？** 没有；新发现里最重的是 N1（blog 队列，Medium，属 conversation scope）。
20. **P24 是否保持 frozen？** 是（`group-runtime-core.js` 零改动；planVersion 3 / plannerId / memberTurnId / targeting / recent / SILENT / DEFER / cap 全部未变）。
21. **P23 是否保持 frozen？** 是（五核心零改动、零 `actorId`）。
22. **DB_VER 是否仍为 24？** 是。
23. **是否需要新 Authority？** 不需要（剩余问题都不是 permission）。
24. **是否需要新 Identity subsystem？** 不需要。
25. **是否需要 Event Bus / Agent Runtime？** 不需要。
26. **P29 是否可以 LOGICALLY FROZEN？** 可以（§24 七条判据全满足）。
27. **如果不能，唯一 blocker 是什么？** n/a（无 blocker）。
28. **如果可以，R2/R3/R4 分别移交给什么后续 owner？** R2+N1 → P30 Workspace Conversation Scope；R3 → Media Attribution / Queue Scope；R4 → Workspace File Provenance；N2 → M4 Group Memory。
29. **下一阶段应该叫什么？** **P30 · Workspace Conversation Scope**（若先做媒体则 `Media Attribution / Queue Scope`；文件溯源则 `Workspace File Provenance`）。
30. **下一阶段是否应继续属于 P29？** 不应——P29 已冻结；后续属于会话作用域 / 媒体 / 溯源三个新scope，不是 identity 阶段。

---

## Final State

**P29-C State: PASS WITH NOTES — P29 LOGICALLY FROZEN**

**P29 · Identity Closure**
**LOGICALLY FROZEN**
