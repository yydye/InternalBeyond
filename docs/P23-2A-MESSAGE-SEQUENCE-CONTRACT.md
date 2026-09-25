# P23 Phase 2A · Message Sequence Contract

阶段目标（用户给定）：**冻结「一次 AI 回合 → N 条独立聊天消息」的数据契约**。

本阶段**不实现**：AI 自动拆句、Delivery Planner、Middle Brain 决定 text/voice/image、
人为随机延迟、typing timing、read delay、多条逐条定时发送、emotion planner、主动消息策略
变化、prompt 注入 sequence 指令、streaming sentence delivery、Voicebox streaming、
image generation planner。

本阶段只回答：**如果上层已经给出一个 sequence，IB 能否正确表示、持久化、hydrate、render、
withdraw、export、search、context reconstruction，并保持兼容。**

状态：`PASS WITH NOTES`（见文末 §17 已知限制 / §18 Phase 2B 阻塞项）。

---

## 1. Phase 0 · 只读审计（重新读源码，不采信历史报告里的 file:line）

审计面（每一条都读的是当前工作区源码）：

| # | 面 | 结论（源码证据） |
|---|---|---|
| 1 | chatMessages canonical schema | `assets/js/chat-core.js`：字段表 `REQUIRED_FIELDS` / `CONDITIONAL_FIELDS` / `LEGACY_FIELDS`，`validateMessage` / `canonicalize` |
| 2 | chat-core canonical whitelist | 同上；`canonicalize` **保留**未知字段并只在 `dropped` 里报告（绝不静默丢数据）——这是"additive 字段无需 migration"的结构性依据 |
| 3 | assistant 消息写入路径 | `communication.js`：单聊流式 / 非流式 / 群聊 / waifu 多段 / `_wsToolContinue` 续轮；`active-diary.js` 主动消息；`active-plans.js`；`activity-runtime.js`；`role-dm.js`；`social.js` 群事件 |
| 4 | dbPut / dbUpdate authority | `core.js:9-25` 是唯一数据访问助手；`chat-authority.js` 把它替换成 Home Node 权威 + IndexedDB 镜像；`home-node-bootstrap.js` 只在 canonical 模式下接管 `chatMessages` |
| 5 | renderAiMessage / render 路径 | 没有 `renderAiMessage`；渲染入口是 `_buildMsgEl` / `appendChatBubble` / `_renderAllChat` / `_renderSegments`，全部**逐条**消费消息对象 |
| 6 | voice-message-core | `assets/js/voice-message-core.js`：`build` / `hasPlayable` / `playSrc` / `isStale` / `dropVoice` / `sanitizeProvenance` / `findSecret` |
| 7 | 富消息结构（images / files / cards） | `images` / `files` 是消息数组字段；卡片（wsSearches / memOps / calNotes）是消息字段；都由**消息**承载，不存在"消息内的多条交付"概念 |
| 8 | withdraw | `_chatWithdrawMsg(msgId)` 按 **message id** 改写 content + `withdrawn` 并 `dropVoice`；`_chatWithdrawSelf` 取"该发送者的最后一条 assistant" |
| 9 | continuation | 两条：① 自动续写（provider `finish_reason=length` → 同一条消息内拼接）；② 用户点「继续生成」→ `workspace.js:continueTruncatedMsg` 就地改写**同一条**消息（content 变长 → `dropVoice`） |
| 10 | regenerate / edit | **不存在**。聊天域没有 regenerate、没有编辑 assistant 消息的入口（`deleteSingleMsg` 只有删除） |
| 11 | export / import | ① 文本导出 `confirmExport`（按会话拼接）；② fs 镜像/全量导出 `core.js`（`chatMessages` 整体复制，含 metadata）；③ `importAll` 逐条 `dbPut` |
| 12 | search | `social.js:searchChat(q)`：按 `content.includes(q)` 过滤当前会话 + `_renderAllChat` |
| 13 | context reconstruction | `communication.js`：`history.map(...)` → provider messages；群聊 `collapseSameRole`；MB 证据走 `dialogue-core.js`；Home Node 走 `services/home-node/execution.js:buildPrompt` |
| 14 | memory extraction | `memory.js` / `memory/auto-memory.js`：按消息逐条取样（`_amMsgsOfDay`、记忆挑选弹窗） |
| 15 | Home Node dialogue | `dialogue-core.js`（桌面与 Node 同一份）；`services/home-node/middle-brain.js` |
| 16 | Mobile DTO | `assets/js/mobile-dto.js`：`messageDto` / `messageMetadata`（metadata 白名单）/ `voiceMeta` |
| 17 | group chat | `communication.js` 群聊分支（多成员各自一次模型调用）、`social.js` 群事件与群会话渲染 |
| 18 | active companion | `active-diary.js`（主动消息 + 自适应理由）、`active-plans.js`（计划驱动） |
| 19 | 其它消费 chatMessages 的模块 | `activity-runtime.js`、`activity/coread.js`、`apps/ib-app-cinema.js`、`calendar.js`、`summary.js`、`favorites.js`、`letters.js`、`role-dm*.js`、`image-edit*.js`、`workspace.js`、`site-operations.js`、`role-letters.js`、`diary.js`、`memory-store.js`、`chat-store.js`、`app-store.js` |

### A. 当前「一个 assistant turn = 一条 chatMessage」在哪些地方被假定？

**回答：几乎处处，但有两处例外 —— 而那两处正是本阶段契约要描述的东西。**

假定"一条"的地方（按证据分类）：

1. **上下文映射**：`history.map(m => ({role: m.role==='assistant'?'assistant':'user', content: ...}))`
   —— 一行消息 = 一行 wire message。
2. **撤回**：`_chatWithdrawMsg(msgId)` / `_chatWithdrawSelf` 以"最后一条 assistant 消息"为单位。
3. **续写**：`continueTruncatedMsg` 把增量拼进**同一条**消息的 content。
4. **语音生命周期**：`voice-message-core.replace`/`dropVoice` 以消息为单位（content 变 ⇒ voice 消失）。
5. **渲染分组**：`appendChatBubble` 的"连续同发送者"判断基于 **DOM 中上一条气泡**。
6. **导出/检索/记忆取样**：都按消息条数计数（`_chatExportMessage`、`searchChat`、`_amMsgsOfDay`）。
7. **Mobile DTO**：`messageDto(message)` 一条进一条出。

已经在做"一次回合多条消息"的**既成事实**（不假定一条）：

8. **waifu 多段呈现**（`communication.js` 非流式分支）：
   `MessagePresentation.plan(replyText,{waifu:true})` → `mode==='multi'` → 循环
   `dbPut('chatMessages', _wMsg)`，id `msg_<ms>_<rand>_<i>`、`timestamp:Date.now()+_i`、
   逐条 `appendChatBubble`。**这就是"上层已经给出的 sequence"，只是它此前没有契约。**
9. **工具续轮**（`communication.js:_wsToolContinueInner`）：模型执行了工具 →
   自动回喂再生成一轮 → **再写一条** assistant 消息（`metadata.toolRound`），
   与主回复同属一个宿主回合（同一个 `_ibTurn`、同一份预算）。

### B. 如果直接把 `sequence: [...]` 塞进 chatMessages，会破坏哪些 consumer？

1. **全表扫描点**（`core.js` 导出 / 计量 / 日历 / 紧急镜像 / `coread` / `app-store`）会把
   sequence 当成一个"消息"，条数与字节数都失真。
2. **撤回**：撤回一条消息会把整段 sequence 一起抹掉（或留下"文本说 A、声音说 B"）。
3. **语音**：一条消息只能有一个 `voice` 字段 → N 段语音里只有一段能存在。
4. **渲染**：`_buildMsgEl` 认识 `content` / `images` / `files` / `voice` / 卡片，
   不认识 `sequence` → 会渲染成空气泡（或 `String(object)`）。
5. **上下文**：`history.map` 会把整个数组 `String()` 化，模型收到 `[object Object]`。
6. **search / memory / export**：`m.content.toLowerCase()`、`String(m.content)` 全部失真。
7. **Mobile DTO**：白名单会静默丢掉 `sequence`（客户端看不到任何东西）。
8. **Home Node**：`chat-store.evaluateWrite` 只认 canonical 字段 + payload 往返，
   `messages` 表的 `content` 列会是空串 → 变更日志/分页全错。

### C. 方案选择（按源码证据，不按提示词预设）

**选中：方案 B —— 每个 delivery unit 都是真正独立的 chatMessage，通过 turn identity 关联。**

决定性证据：

1. **不变量 1（一个交付单元 = 一条 canonical 消息）与 UI 的独立性要求只能由方案 B 满足**：
   撤回 / 删除 / 收藏 / 播放 / 重试在今天的实现里**全部以 message id 为单位**，
   方案 A（一条 parent 内嵌 segments）会同时要求这四处新增第二套"子单元寻址"。
2. **生产里已经这么做**（waifu 多段、工具续轮）——契约描述现实，而不是想象另一种现实。
3. **id 形状早就为此预留**：`chat-core.ID_SHAPES.assistantPart = 'msg_<ms>_<rand>_<i>'`
   且 `test_chat_core_contract.js` 里已登记 "waifu 分段" 写入形状。
4. **零迁移**：metadata 是 canonical conditional 字段、Home Node 存 payload_json，
   未知键原样往返（`chat-store.evaluateWrite` + `canonicalize` + `test_chat_migration` 的
   "未知字段原样往返" 断言）。方案 A 需要新结构 + 新渲染 + 新 DTO + 新 store 语义。

**被否决的替代方案**

| 方案 | 否决理由（证据） |
|---|---|
| A · 一条 parent message 内嵌 `segments` | 与 91 个逐条读取点冲突；撤回/播放/删除/收藏/搜索/记忆全部要新增子单元寻址；`content` 不再是文本 authority（违反不变量 6）；Mobile DTO 白名单只能整体丢弃 |
| C · 新 store（`chatTurns` 表）存 sequence，chatMessages 只存指针 | 引入第二个 canonical store + 跨 store 事务，而权威是 Home Node SQLite 单库（`chat-authority.js` 的 fail-closed 语义会立刻复杂化）；且它并不能解决"单元要独立撤回/播放"这一条 —— 单元仍必须是消息 |
| D · 只在渲染层拆（renderer illusion） | 用户明确排除：后续阶段需要单独延迟/typing/发送/撤回/播放/retry，幻觉层无法承载 |
| E · 用伪造时间差（`Date.now()+i`）表达顺序 | 用户明确排除；且实测它已经造成真实缺陷：工具续轮先落库、主回复落库更晚 → 主回复排到续轮下面 |

---

## 2. Canonical schema（本阶段冻结）

### 2.1 输入契约（上层 → IB）

```js
{
  turnId: 'turn_xxx',                    // 必须：本回合的稳定身份
  units: [                               // 必须：1..60 条
    { kind: 'text',  text: '不是，你等等' },
    { kind: 'voice', text: '你是 Cakumi 团队的人？',      // text = 文字稿（= content）
      dataUrl?: 'data:audio/…', audioUrl?: '/tts/<id>.mp3',
      mime?, duration?, provenance?: { source, provider, engine, model, voiceId, voiceType, refAudioId, profile } }
  ]
}
```

* `kind` 本阶段正式支持 `text` / `voice`；`image` **只登记**（`RESERVED_KINDS`），
  出现即被确定性拒绝（`unsupported-kind:<i>:image`），planner 属后续阶段。
* 校验词表（稳定、可断言）：`not-an-object` / `missing-turnId` / `missing-units` /
  `no-units-array` / `too-many-units` / `unit-not-object:<i>` / `missing-kind:<i>` /
  `unsupported-kind:<i>:<kind>` / `unplayable-voice:<i>` / `secret-in-unit:<i>` /
  `secret-in-metadata`。
* 空的 text 单元进 `dropped`（`empty-text`），不产出消息；`unplayable-voice` /
  `secret-*` 是**整批拒绝**（fail closed）——一条消息一旦落库就已经是事实。

### 2.2 输出（canonical chatMessages[]）

每条单位一条消息，形状与既有 assistant 写入点**逐字同族**：

```js
{
id: 'msg_<timestamp>_<6位熵>_<补零序号>',   // 与 ID_SHAPES.assistantPart 同族，isKnownMessageId 承认
                                          // 熵只由 turnId 决定 ⇒ 按 id 升序 == 按 sequenceIndex 升序
  role: 'assistant',
  content: '<unit.text>',                   // 文本 authority（不变量 6）
  metadata: { turnId, sequenceIndex, sequenceTotal?, model?, model_id?, config_id?, showThinking?, <extra…> },
  friendId, timestamp,                      // 同一回合的所有单元共享同一个 timestamp
  voice?: <voice-message-core 的 canonical voice 对象>   // 仅 voice 单元
}
```

* **不产生 parent 行**（不变量 8）。没有 sequence 的回合，写入形状逐字不变（不变量 10）。
* id 由 `(turnId, index, timestamp)` 唯一决定 ⇒ **同一个 sequence 构造两次得到逐字相同的 id**，
  于是重放同一个 sequence 在 Home Node 落到同一条记录（`chat-store` 的 id 级幂等：
  `identical → skipped`），不会写第二遍。熵 6 位十进制（1e-6），严格优于既有写入点的
  `Math.random()*100000`（1e-5）。
* 熵只由 `turnId` 决定、序号补零（`_000`/`_001`…）⇒ **按 id 升序与按 sequenceIndex 升序
  逐字同序**。这不是美学选择：存储层的自然顺序就是 id 升序（IndexedDB 的 key），于是
  任何没有调用 `orderMessages` 的读取点（跨阶段冻结的 `social.js`、测试 harness、
  未来消费者）也不会拿到乱序。P23 Phase 2B 的浏览器端到端实测逼出了这一条
  （见 `docs/P23-2B-DELIVERY-RUNTIME.md` §16.4）。

---

## 3. Turn identity

放在 `metadata`（不是新顶层字段），因为 metadata 已经是"跨消息的每消息注解"的家：
**M1 的 `activityId` 就是同一个概念的前例** —— 同一宿主回合的 user 与 assistant 共享
`metadata.activityId`。收益：

* 不需要新顶层字段（`KNOWN_FIELDS` 不变 ⇒ `canonicalize` 不会把它报成 schema 漂移）；
* 不需要 DB migration（payload JSON 原样往返，`test_chat_migration` 已断言）；
* 旧消息一个键都不变。

生产点的取值：

* 单聊宿主回合：`_turn.turnId = IBDeliverySequence.turnIdFor(userMsg.id)` ——
  种子是触发本回合的 user 消息 id，确定性且唯一，**不新增 id 分配权**。
* waifu 多段：由 Sequence Core 构造，全部单元共享该 `turnId`。
* 工具续轮：`metadata.turnId = _turn.turnId`、`sequenceIndex = round+1`；
  主回复在**确认发生过续轮**时补 `sequenceIndex: 0`。
* **单条回合不写这个键**（所以"旧 AI 调用路径行为完全一致"）。
* **群聊不写**：群聊每个成员是各自一次模型调用，"回合归属"（成员级 vs 群级）
  需要单独设计 —— 本阶段不为群聊引入 per-member turn（见 §17）。

---

## 4. Ordering（确定性排序依据）

契约（唯一实现 = `assets/js/delivery-sequence-core.js`）：

1. 基础顺序：`(timestamp, id)`（`id` 只是确定性兜底 —— IndexedDB 的 `getAll`/`byFriend`
   本来就按 key(=id) 升序返回，这一步把"引擎碰巧给的顺序"写成契约）；
2. 同一 `turnId` 的所有单元聚成**连续块**，块的位置 = 该回合在基础顺序里第一次出现的位置；
3. 块内按 `sequenceIndex` 升序；
4. 没有回合键的旧消息逐字保持基础顺序。

为什么不是"只在 timestamp 相同的时候才看 sequenceIndex"：真实缺陷是
**主回复的 timestamp 比续轮更大**（续轮先落库），只做 tie-break 修不好它。

调用点（全部走同一函数）：
`communication.js`（小窗渲染 / 单聊历史 / 群聊历史 / 摘要窗口 / 撤回查找 ×2 / 导出）、
`social.js` **未改**（受 Astra 只读面守卫约束，见 §17）、`memory.js`（×5）、
`active-diary.js`（×3）、`role-dm.js`（×2）、`image-edit.js`（×1）、`core.js`（紧急镜像）、
`services/home-node/chat-store.js`（取页后 `base:'given'` 归组，不重排 SQL 全序）。

**同毫秒稳定排序**：`orderMessages` 是集合级函数（不是逐对比较器），因此
"两个不同回合在同一毫秒各有多少条"不会把它们的单元交错 —— 每个回合都是连续块。
逐对比较器 `compareMessages` 同时提供（其余场景与测试用），两者对同一集合给出
一致结果，唯一差异就是跨回合同毫秒的交错（文档化）。

---

## 5. Persistence / hydrate

* 权威仍是 Home Node SQLite（`chat-store`）：`messages` 表 + `payload_json`，
  排序 `(timestamp, insert_seq)`、分页 keyset —— **未改动**。
* N 条消息 = N 个独立 id、同一个 `turnId`、稳定 `sequenceIndex`；
  reload / hydrate 之后由 `orderMessages` 恢复同一顺序（`test_message_sequence_contract.js` 断言）。
* 镜像（IndexedDB `chatMessages`）逐条存 payload ⇒ additive metadata 自动随之往返。
* **不需要 DB migration**：证据 = metadata 是 canonical 字段、payload 原样往返
  （`chat-store.evaluateWrite` → `canonicalize`）、且 `test_chat_migration` 的
  "未知字段原样往返" 断言在本次改动后仍然通过。

---

## 6. Withdraw / Edit / Regenerate / Continuation

| 动作 | 本阶段语义（冻结） |
|---|---|
| 撤回一个 unit | 只撤回**该条消息**（`_chatWithdrawMsg(msgId)` 已按 id 工作）。A / B / Voice C 里撤回 B ⇒ `A / [撤回] / Voice C`，**不是**整回合一起撤回。未来若要"撤回整个 turn"，属后续阶段。 |
| 撤回 voice unit | 继续走 `IBVoiceMessage.dropVoice`（音频 + 文字稿 + provenance 一起消失，Phase 1 契约不变）。 |
| 编辑 text unit | 只影响该条消息（今天没有编辑入口；渲染层用 `contentHash` 防御陈旧音频，Phase 1 已冻结）。 |
| continuation（自动续写 / 「继续生成」） | **属于原 unit**：就地改写**同一条**消息的 content（`dropVoice`）。不产生新回合、不产生新 unit。 |
| regenerate | **今天不存在**。因此本阶段不改变任何 regenerate 语义（"悄悄变成重生成整个 sequence" 这件事不可能发生，因为对象不存在）。 |
| 删除单条 | `deleteSingleMsg(id)` 只删该条（unit 级，不变）。 |

`<withdraw/>` 自主撤回仍然只影响**该发送者的最后一条** assistant 消息 = 该回合的最后一个 unit；
这是"unit 级撤回"的自然结果，不是"整回合撤回"。

---

## 7. Provider wire compatibility

审计结论（每个 provider 的 wire 由 `provider-directory.js` 的 format 三分法决定）：

| format | 相邻同 role 是否合法 | 本阶段处理 |
|---|---|---|
| `openai`（OpenAI / DeepSeek / MiMo / GLM / Qwen / Mistral / Grok / Moonshot / Doubao / custom…） | 合法（接受连续 assistant/user） | **原样**（与改动前逐位一致） |
| `anthropic` | Messages API 会合并相邻轮（源码注释 `role-dm-core.js:1216` 已登记同一事实） | **原样** |
| `gemini` | `contents` **要求 user/model 交替**，连续两个 model 轮 = 非法请求 | 在请求构造边界**合并**相邻同 role |

唯一实现：`ib-model-core.js:normalizeWireRoles(messages, format)`（`ALTERNATION_FORMATS`），
三个调用点：`buildRequestBody`（Home Node 执行器所在的同一条路径）、
`callApiChatStream` 与 `callApiChat` 的 gemini 分支（桌面就地在 `_ibWireMessages` 转调）。

`Storage truth ≠ Wire representation`（不变量 11）：数据库里的独立消息一条都没动，
只有请求体被归一，且**只对要求交替的 format** 生效。这不是新语义：**它修的是一个既有缺陷** ——
今天一个 waifu 用户用 gemini 发第二轮，历史里就是两个连续 model 轮。

---

## 8. Memory / Context / Search

* 因为**不存在 parent 行**，"parent + child 双份注入"在结构上不可能发生（不变量 8）。
* 上下文：`history.map` 逐条映射（连续 assistant 行在 OpenAI/Anthropic 合法；
  gemini 在 §7 的边界合并）。
* MB 证据：`dialogue-core.js` 的 `assemble` 本来就逐条（`HISTORY_MAX_MESSAGES=8`），
  N 条 unit 会占 N 行 —— 与"用户在 IM 里连收三条"语义一致。
* search：`searchChat` 按 content 过滤 ⇒ 命中的是**具体某一条 unit**（而不是一团 mixture）。
* memory 取样 / 主动消息上下文 / 日记：都逐条读取（`_activeRecentMessages` 等），
  顺序改走 `orderMessages`。
* 导出：`confirmExport` 与 fs 全量导出都按 canonical 顺序逐条输出。

---

## 9. Export / Import

* 文本导出（`confirmExport`）：顺序 = canonical 顺序；voice unit 的 `content` 就是文字稿，
  因此导出不丢内容（音频本身按 Phase 1 契约不进文本导出）。
* fs 全量导出/导入（`core.js`）：`chatMessages` **整体复制**（只删 `upstreamRaw` /
  `thinkingSources` 两个 legacy 字段）⇒ `metadata.turnId/sequenceIndex/sequenceTotal`
  原样往返；导入是逐条 `dbPut`，不产生 parent、不产生重复（id 相同 ⇒ Home Node
  判 `identical` ⇒ `skipped`）。
* 旧导出文件仍然兼容（缺 metadata 的旧消息照常导入，不补键）。

---

## 10. Mobile DTO

`mobile-dto.js` 是本阶段唯一补的 DTO 面：

* `messageMetadata` 白名单 +`turnId` / `sequenceIndex` / `sequenceTotal`
  （非法序号**丢弃**而不是归零 —— 归零会让"第 3 条"谎称"第 1 条"）；
* `voiceMeta` 补 Phase 1 已登记的缺口：`audioUrl`（**只接受** `/tts/<name>.<ext>` 形状的
  Bridge 引用）+ `provenance`（走 `voice-message-core.sanitizeProvenance` 的同一份白名单清洗）+
  `playable`（canonical 判定）。`dataUrl`（音频本体）**仍然不发**。
* 移动端 Delivery Planner **不在本阶段**（只是把 DTO 契约闭合）。

---

## 11. 不变量（冻结）

见 `docs/CHAT_MESSAGE_CONTRACT.md` §9 —— 12 条逐字与用户给定的清单对应。

---

## 12. 修改文件

| 文件 | 改动 |
|---|---|
| `assets/js/delivery-sequence-core.js` | **新增**（纯模块：validate / buildMessages / turnId / orderMessages / compareMessages） |
| `InternalBeyond.html` | 新增一行 script（插在 `voice-message-core.js` 与权威层之间的既有说明区内） |
| `assets/js/communication.js` | 顺序归一（8 处读取点）、waifu 多段改走 Sequence Core、工具续轮 + 主回复打回合身份、`_ibWireMessages` 转调、`_ibOrderMessages` 转调 |
| `assets/js/ib-model-core.js` | 新增 `normalizeWireRoles`（唯一 wire 归一实现）+ gemini 分支调用 + 导出 |
| `assets/js/mobile-dto.js` | 回合身份白名单 + `voiceMeta` 补 audioUrl / provenance / playable |
| `assets/js/memory.js` | 顺序归一（5 处）+ 转调 helper |
| `assets/js/active-diary.js` | 顺序归一（3 处）+ 转调 helper |
| `assets/js/image-edit.js` | 顺序归一（1 处） |
| `assets/js/core.js` | 紧急镜像打包顺序归一 |
| `services/home-node/chat-store.js` | 取页后回合归组（`base:'given'`，不重排 SQL 全序、不改分页锚点） |
| `docs/CHAT_MESSAGE_CONTRACT.md` | §4.1 回合身份 + §9 不变量 |
| `docs/P23-2A-MESSAGE-SEQUENCE-CONTRACT.md` | **新增**（本文件） |
| `tests/test_message_sequence_contract.js` | **新增**（A–X 全量契约测试） |
| `tests/test-all.js` | 登记新测试（static 组） |

**未改**（刻意）：`chat-core.js`（契约字段表与 id 形状表不变）、
`voice-message-core.js`（Phase 1 冻结）、`social.js`（Astra 只读面守卫，见 §17）、
`dialogue-core.js` / `context-snapshot.js` / `services/home-node/execution.js`
（Astra 只读面 READONLY_PROFILE）、`services/home-node/middle-brain.js`（同）、
**`assets/js/role-dm.js`**（见下）。

### 12.1 两个**冻结面**（本轮实测的硬约束，不是"没想起来"）

1. `tests/test_disclosure_authorization.js` 的 `W5b` 把
   `disclosure-core / disclosure-authoring-core / **role-dm.js** / role-dm-core /
   disclosure-store / social.js` 六个文件钉成"**任何内容都不得修改或删除**"，
   唯一豁免是 `social.js` 上落在 Voice 区段内的**新增行**。
   ⇒ 本阶段**第一版曾把 role-dm.js 的会话读取也接到 canonical 顺序**，
   该守卫立刻变红（报"区段外新增: assets/js/role-dm.js:95"）。
   已按工作区纪律**完整回滚 role-dm.js**（`git diff HEAD -- assets/js/role-dm.js` 为空，
   行尾也已还原为 CRLF 以保持逐字节不变），并把该文件列为**不可改**。
2. `tests/test_moments_acl_contract.js` 用**行号**豁免 `active-diary.js` 里两处
   memory 域的可见性判定（`_memRepairVisibleState` 的 `only`+空 `visibleTo`）。
   ⇒ 在它们**上方**插入任何行都会让豁免漂移。因此本阶段在 active-diary.js 的
   转调 helper 被放到**文件末尾**（函数声明在同一 IIFE 内提升，位置不影响语义）。
   证据：移动之前该测试红（offender = active-diary.js:1008），移动之后 66/66 绿。

---

## 13. 测试

`tests/test_message_sequence_contract.js`（static 组，零依赖 / 零网络 / 零浏览器）
覆盖用户给定的 A–X：

A 单条 text · B text+text · C text+voice · D voice+text · E 3+ units · F 唯一 id ·
G 同一回合身份 · H 确定性 sequenceIndex · I reload 顺序 · J 同 timestamp 顺序 ·
K 撤回一个 unit · L 撤回 voice unit（voice 消失）· M legacy 消息兼容 ·
N legacy 单条路径不变 · O export/import · P search · Q context reconstruction ·
R provider wire 归一（含连续 assistant 的 provider 兼容性）· S secret 探测 ·
T malformed sequence · U 空 unit · V stale voice · W Mobile DTO ·
X 无重复 memory/context 注入。

额外两组（本次实测）：
* **AD · 生产适配器（真实函数体）**：把 `communication.js` 的
  `_ibDeliveryCore` / `_ibSequenceMessages` 逐字抽出、在沙箱里执行 ——
  证明 waifu 多段交付真的经由契约构造（回合身份、额外 metadata、共享 timestamp、
  重放确定性、核心缺席时返回 null 而不是手写第二份逻辑）。
* **K/L · 撤回**：执行 `communication.js:_chatWithdrawMsg` 的**真实函数体**（桩 store），
  证明按 id 的 unit 级撤回、兄弟 unit 不受影响、voice unit 撤回后音频/文字稿/provenance 全部消失。

总断言数：**164 项全绿**（`node tests/test_message_sequence_contract.js`）。

### 13.1 本轮 `node tests/test-all.js --quick` 的实测口径

`static 117 项 · 6 失败`（p22-ui 组全绿）。六条失败**全部**在**未改动的干净 HEAD
worktree** 上复现（`git worktree add --detach <tmp> HEAD` 后逐条跑过），逐条归属：

| 失败 | 与 P23 2A 的关系 |
|---|---|
| `test_frontend_structure`（5 条 BOM） | 五个**未触碰**文件在 HEAD 上就缺 BOM（见 §16） |
| `test_middle_brain_convergence_counterproof`（`base.copyClosureIsComplete`） | 该断言在 HEAD 上已红（缺 `home-node-service → desktop-credential / catalog-bootstrap` 两条边）；本阶段新增两条 require 边（`mobile-dto → voice-message-core`、`chat-store → delivery-sequence-core`）出现在**同一条**失败信息里 |
| `test_home_node_client_envelope`（1 条） | HEAD 上同样 1 条失败（54/1） |
| `test_anthropic_wire_contract`（1 条） | 与 git 忽略的 `Economy-v1-release/`（P22 发行暂存目录）里的 `ib-model-core.js` 副本重名匹配；该副本不含本阶段代码，是**工作区既存状态** |
| `test_installer`（5 条） | HEAD 上同样失败（缺 `runtime/node/node.exe` 等 payload 前置） |
| `test_update_card`（1 条） | 它断言 "test_frontend_structure 仍然全绿" —— 上游那条既存红导致 |

另外两条**在阶段中期变红、并已修好**（记录在此以免下次重新踩）：
`test_moments_acl_contract`（active-diary.js 行号漂移，见 §12.1）与
`test_disclosure_authorization`（role-dm.js 命中 W5b 冻结面，已完整回滚）。

浏览器侧两条最小实测（真实页面 + 真实 Chrome）：
`test_boot_smoke.js` **11/11 通过**（新模块挂载、页面零未捕获异常）；
`test_m1a_chat_authority_smoke.js --browser` 的 **17 条 chat / authority / mirror /
fail-closed 断言全部通过**（真实 `sendChatMessage` + 真实 Home Node + 真实 SQLite），
另有 6 条与 HEAD **完全一致**的既存失败（mobile 发布面需要 `IB_HOME_NODE_TOKEN`）。
`test_p22_6_economy_runtime` 在本轮最终跑里为**通过**（此前一次失败是环境性的 401）。

同时回归：`test_chat_core_contract` / `test_chat_authority` / `test_chat_migration` /
`test_dialogue_authority` / `test_mobile_*` / `test_home_node_*` / `test_model_core_contract` /
`test_reasoning_capability` / `test_voice_*` / `test_astra_readiness_observe` /
`scripts_check_html` / `test_frontend_structure`（后者的 5 条 BOM 失败为**基线既存**，
见 §16）。

---

## 14. 安全发现

1. **sequence 输入的秘密边界**：`secret-in-unit` / `secret-in-metadata` ⇒ 整批不产出
   （fail closed）。元数据是**构造式白名单**：输出对象的每个键都由核心逐字写出，
   额外注解只接受标量。
2. **voice provenance 不新建第二套清洗**：复用 `voice-message-core.sanitizeProvenance`
   （白名单 + 秘密键/值过滤）。测试里用 `findSecret` 对构造结果做反向探针。
3. **Mobile DTO**：`audioUrl` 只接受 Bridge 引用形状（拒绝任意 URL —— 否则 DTO 会变成
   "把记录里的任意字符串发给设备"的通道）；`dataUrl`（音频本体）继续不发。
4. **未发现**新的凭据承载面；`P23_VOICE_UI_ONLY` 守卫的凭据形状判据在本次改动后仍然通过。

---

## 15. 存储发现

1. **同毫秒多消息**此前没有确定性判据（只 `timestamp`）；本阶段给出集合级确定性顺序。
2. **工具续轮顺序颠倒（真实缺陷）**：续轮先落库（t1）、主回复后落库（t2 > t1），
   只按 timestamp 排序 ⇒ reload 后主回复排到续轮**下面**。回合身份 + `orderMessages` 修好它。
3. **既有 id 熵 1e-5**（`Math.random()*100000`）在 sequence 上被收紧到 1e-6（确定性派生）。
4. **零迁移**：additive metadata + payload 往返 ⇒ 不需要 DB 版本变更。

---

## 16. 基线既存失败（与本次改动无关，如实记录）

`node tests/test_frontend_structure.js` 有 **5 条 BOM 失败**，全部落在**本次未触碰**的文件上：
`assets/css/economy-shell.css`、`assets/js/economy-configuration-core.js`、
`assets/js/economy-shell-core.js`、`assets/js/economy-shell.js`、`assets/js/home-node-client.js`。
证据：`git status --short` 对这五个文件**无输出**（= 与 HEAD 逐字相同），
而工作区读出的前三个字节不是 `EF BB BF` ⇒ 该失败在 HEAD 上就存在。
本阶段不修改别阶段的文件来"顺手变绿"（工作区纪律 §17）。

---

## 17. 已知限制

1. **social.js 的顺序未归一**（4 个读取点：全屏渲染 / 归档 / 线程 / 日历）——
   `test_astra_readiness_observe.js` 的只读面守卫把 `assets/js/social.js` 冻结为
   "只允许 P23 Voice 的既有豁免区段内新增"，任何区段外的改动都会让该守卫变红。
  后果：全屏视图在**同一回合超过 9 条** `_<i>` 分段时可能按 id 字典序显示
   （`_10` < `_2`），工具续轮的主回复在全屏 reload 后仍会排在续轮下面。
   **这一条必须由后续阶段连同守卫一起处理**（见 §18）。
   （同一份冻结还来自 `test_disclosure_authorization.js` 的 `W5b`；两处守卫都必须
   先对齐才能动 social.js 的 chat 读取。）
1b. **role-dm.js 的顺序未归一**（1 个会话读取点）—— 见 §12.1，该文件被 `W5b`
   钉成逐字节不可改。角色私信是角色↔角色会话，不影响用户聊天视图。
2. **群聊没有回合身份**：`sequenceIndex` 只在单聊回合生成。群聊每个成员各自一次模型调用，
   "一个群回合"与"一个成员回合"是两个不同的概念，需要单独设计（否则多个成员的消息会被
   错误地聚成同一个 turn 块，破坏成员之间的顺序）。
3. **`sequenceTotal` 是 advisory**：工具续轮在写第一条消息时还不知道本回合会有几条。
   读取方必须以消息集合（按 `turnId` 计数）为准。
4. **分页边界**：Home Node 的分页锚点仍是 `(timestamp, insert_seq)`，
   一个回合的单元理论上可能被页边界切开（桌面镜像读取是全量 `byFriend`，不受影响）。
5. **gemini 首轮 role**：`normalizeWireRoles` 只合并**相邻同 role**；
   若窗口切片以 assistant 行开头，Gemini 仍可能拒绝"首轮非 user"。
   这是既存行为（与本阶段无关），未在本阶段改动以避免丢证据。
6. **id 熵 1e-6** 仍是概率性：极端情况下（同一毫秒、不同回合、6 位哈希相撞、同一序号）
   两个回合的第一条消息可能同 id —— 概率严格优于既有的 1e-5 写入点。

---

## 18. Phase 2B 阻塞项

1. **social.js 与 Astra 守卫的所有权冲突**：要归一全屏/归档/线程/日历的读取顺序，
   必须先与 Astra Readiness 守卫的 owner 对齐（要么在 `P23_VOICE_UI_ONLY` 里登记
   一个窄区段，要么把 social.js 的 chat 读取抽到自带顺序的文件里）。
   在解决之前，**不要把与序列相关的 UI 断言建立在 social.js 的排序上**。
2. **群聊的回合身份设计**（成员级 vs 群级）+ 群聊工具续轮的顺序修复。
3. **Delivery Planner / 拆句 / 节奏**（Phase 2A 明令禁止）：规划器只能产出本契约的
   `sequence` 输入，不得自行决定 id / 顺序 / 落库。
4. **分页与回合边界**：若移动端需要"按回合翻页"，`chat-store.listMessages` 的游标语义
   需要与 `orderMessages` 的归组对齐（本阶段只做了取页后的归组）。
5. **编辑 / regenerate 入口**：一旦引入，必须走 `voice-message-core.dropVoice`
   与"content 是唯一 authority"（本阶段已把语义写死，但没有入口）。
6. **role-dm.js 的会话顺序**：该文件被 `W5b` 冻结为"逐字节不得改"，因此角色私信
   （角色↔角色）的会话读取仍然是 `(timestamp)` 序。若要归一，必须与 disclosure 冻结面
   的 owner 对齐（把 chat 读取抽到自带顺序的文件里，或登记一个窄豁免）。
