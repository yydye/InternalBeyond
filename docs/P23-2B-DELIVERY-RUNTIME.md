# P23 Phase 2B · Delivery Runtime

Phase 2A 解决「多条消息是什么、怎么存」；Phase 2B 只解决**这些消息如何被交付**。

本阶段**不**决定：为什么拆成四条 / 哪条该是 voice / 应该写什么内容（Phase 2C Planner）。
也**不**做：Group Runtime、主动消息策略重构、emotion planner、personality rewrite、
新 Memory 类型、Voicebox streaming、image generation planner、大规模 chat schema migration。

状态：`PASS WITH NOTES`。

---

## 1. Phase 0 · 只读审计（重新读当前源码）

| 面 | 结论（源码证据） |
|---|---|
| Phase 2A contract | `assets/js/delivery-sequence-core.js`：`validate` / `buildMessages` / `turnIdOf` / `sequenceIndexOf` / `orderMessages`；一条 unit = 一条 canonical chatMessage，回合身份在 `metadata.turnId/sequenceIndex/sequenceTotal` |
| assistant 生成路径 | `communication.js`：单聊流式 / 非流式 / 群聊；waifu 多段（非流式）；`_wsToolContinue` 工具续轮 |
| 完成期渲染 | 流式：`_createStreamBubble` 先画、`_wsFinalizeBubble` 以完整文本重建，**然后** `dbPut`；非流式：`dbPut` **然后** `appendChatBubble` |
| 写权威 | `core.js` 数据助手 → `chat-authority.js`（Home Node canonical + IndexedDB 镜像） |
| 渲染权威 | `appendChatBubble`（增量追加） / `_renderAllChat`（按 DB 全量重渲染） / `_syncMiniAfterStream` |
| typing 现状 | 单聊 `div.chat-typing#chat-typing-<friendId>`（含 1s 秒表），群聊 `div.chat-typing`（无 id）；**没有**任何集中注册/清理点 |
| auto scroll | `appendChatBubble` 与 `_chatWinPin` 负责；交付多一条消息 = 多一次滚动，无需新机制 |
| voice autoplay | **原生 voice message 没有 autoplay**（点击播放 `_vmTogglePlay`）；唯一的 autoplay 是 `bridge.js:ibAttachTts` 的**文本→TTS**：`ibObserve` 的 MutationObserver 在气泡**进入 DOM 后** 1200ms 入队 |
| abort | `stopStreaming()`：只中止 provider 传输 |
| regenerate | 不存在（聊天域没有 regenerate 入口） |
| thread/会话切换 | `social.js:selectFriend/selectThread`（**冻结文件**）重写两个容器 |
| withdraw | `_chatWithdrawMsg(msgId)`：按 id 的 unit 级撤回 |
| active conversation identity | `activeFriendId` + `activeThreadId` → canonical `conversationId`（chat-core 派生） |
| communication.js / bridge.js / voice runtime | communication.js 是生成 + 渲染 + 广播的宿主；bridge.js 负责 richer 文本与 TTS 自动朗读；voice runtime 负责取源与播放 |
| Activity/Cinema 重叠 | `apps/ib-app-cinema.js` 订阅 `IBApps` 的 `message` / `turn` 广播，自带 `.ci-typing`（60s 超时兜底）——本阶段不改它，只让广播语义与交付对齐 |

### A. 当前 assistant message 是「先 persist 后 render」还是反过来？

**两条路都有，按是否有流式：**

* 流式：**先 render**（`_createStreamBubble` → 边流边画）→ 完成时 `_wsFinalizeBubble` 用完整文本重建 → `await dbPut('chatMessages',aiMsg)`。
* 非流式：`await dbPut('chatMessages',aiMsg)` → `appendChatBubble(...)`。
* waifu 多段（非流式）：逐条 `delay → dbPut → appendChatBubble`。

### B. Phase 2A 的 sequence 当前在哪里 materialize 成 N 条 chatMessages？

**只有一处**：非流式分支里的 waifu 多段循环（`_ibSequenceMessages` 构造 → 内联 `for` 循环逐条 `dbPut` + `appendChatBubble`）。另一条"一次回合多条"是**增量**写入的工具续轮（`_wsToolContinueInner`，每轮一条，立即交付）。
也就是说：Phase 2A 之后，"交付"这件事实际上是**一段内联循环**，没有名字、没有状态、没有取消。

### C. 有没有现成的 queue / scheduler / typing runtime 可以复用？

* **没有**通用队列/调度器。全仓唯一的 queue 是 `bridge.js` 的 TTS 播放队列（`_ibTtsQueue`），语义是"语音排队"，不能复用。
* **有**可复用的零件：typing DOM（`div.chat-typing`）、`_showStreamingUI`（stop/send 按钮切换）、`appendChatBubble`（渲染权威）、`MessagePresentation.delayBetween`（既有节奏公式）、`IBApps.broadcast('turn'|'message')`（Cinema 的 typing 与弹幕）、`_chatCallStates`（按对话的调用状态）。
* 结论：新模块只负责"队列与时间"，其余一律复用。

### D. sequence 尚未交付完时，用户做出下列动作会怎样？

| 动作 | 改动前的真实行为 |
|---|---|
| 切换角色 | 后续 unit 仍会落库；渲染被 `activeFriendId===_targetFriend` 挡住 → 不串角色（正确） |
| 切换 thread（同角色） | **缺陷**：循环只比较 `activeFriendId`，后续 unit 会被追加进话题频道的全屏列表 |
| 发送新消息 | 第二轮生成**与**第一轮交付并发；新一轮上下文只含已落库的 unit（因为 unit 到达才落库）→ "看不到未来消息"这条性质**已经成立** |
| regenerate | 不存在 |
| stop | `stopStreaming()` 只中断 provider 传输；交付循环不受影响 → 停不下来 |
| withdraw | 只能撤回已交付的（在 DB 里的）那条；排队中的还不可撤回（还没有 id 对应任何行） |

### E. voice autoplay 在哪一层触发？

**在"气泡进入 DOM"之后**（`bridge.js:ibObserve` 的 MutationObserver → `ibAttachTts` → `vc.autoPlay` 时 1200ms 入队 TTS）。
因此它天然是"交付后"的：未交付的 unit 没有 DOM 节点，也就不可能提前播放。
原生 voice message 本身**没有** autoplay（只有点击播放）——所以"sequence 一开始就听到 C"这种风险在当前实现里不存在，本阶段的工作是**保持**这一点。

---

## 2. Ownership audit（本阶段动手前）

| 区域 | 归属 / 状态 | 本阶段 |
|---|---|---|
| `assets/js/role-dm.js` | `test_disclosure_authorization.js` 的 `W5b` 冻结（逐字节不得改） | 不碰 |
| `assets/js/social.js` | `W5b` + Astra 只读面守卫（只允许既有 Voice 区段内新增） | 不碰（因此全屏/归档/线程/日历的读取顺序仍不归 Phase 2B） |
| Astra READONLY_PROFILE（`dialogue-core` / `context-snapshot` / `middle-brain-*` / `services/home-node/{middle-brain,thread-retrieval,execution}.js`） | 冻结 | 不碰 |
| `InternalBeyond.html` | 只允许在"Voice 卡片区段"与"`voice-message-core.js` → `chat-authority.js` 脚本区段"内新增 | 新 script 标签落在脚本区段内 |
| `communication.js` | 多批次共享：P23-1 Voice、M1 Activity/Cinema 接缝、P23-2A 序列契约 | 只做加法：新 adapter 区块 + 生成期 typing 的创建/销毁收敛 + 交付入口/取消钩子 |
| `communication/voice.js`、`bridge.js`、`apps/ib-app-cinema.js`、`active-diary.js`、`active-plans.js`、`activity-runtime.js` | 其它批次 | 不碰 |
| 新增 | `assets/js/delivery-runtime.js`、`tests/test_delivery_runtime.js`、本文件 | 本阶段 |

纪律：全程没有 `git checkout --` / `git reset --hard` / `git clean`；唯一的仓库外副作用是
为取证创建了一个临时 `git worktree`（只读 HEAD，已从 worktree 列表移除）。

---

## 3. 选定的 runtime 架构

```
delivery-sequence-core.js     结构：sequence → canonical chatMessage[]
        ↓（单向依赖）
delivery-runtime.js           时间与生命周期：队列 / 状态 / typing 开关 / cancel
        ↓（adapter）
communication.js 的交付区块    真实动作：dbPut + appendChatBubble + 广播 + typing DOM
```

* Core 是纯的（`P23-2A` 已冻结）；Runtime 也是纯的（注入时钟，零 DOM / 零存储 / 零网络）；
  Adapter 才是唯一碰 DB 与 DOM 的地方。
* 因此"未交付 unit 不进任何 consumer"这条硬验收线是**结构性**的：队列只活在内存里。
* 群聊兼容：队列按 canonical `conversationId` 绑定（`dm:<friendId>[|<threadId>]` /
  `group:<groupId>…`），并带 `scope: single|group` 标注；runtime **不使用** scope 做任何分支
  ⇒ 未来 Group Runtime 可以直接把 group 会话送进来，而本阶段一行群聊行为都没实现。

## 4. Persistence timing 决定

**选 B：每个 unit 到它自己的 delivery time 才 `dbPut`**（不预写、不留影子行）。

理由（源码事实）：

1. `chatMessages` 有 91 个读取点（provider context / Memory / Search / Middle Brain /
   Diary / Role Letters / Home Node dialogue / Mobile DTO / 导出），**没有任何一处**认识
   "投递队列"。若选 A（创建时全写 + UI 延迟显示），就必须让每一个 consumer 都学会过滤
   "尚未交付"的行 —— 那是给 91 个读取点加一条新语义，而不是加一个 runtime。
2. 选 B 时，"用户在 UI 只收到 A 时下一轮模型看不到 B/C" 是**免费**的：B/C 根本不在库里。
3. reload / crash：已交付的在 DB，未交付的随页面消失（队列 ephemeral，不做恢复）。

代价（如实记录）：交付中的 unit 在 DB 里"还不存在"，因此它不能被撤回（也没有 id 对应任何行）。
这正是 §15 的要求：queued unit 不是 chatMessage ⇒ 只能 cancel，不能 withdraw。

## 5. Queue lifecycle

```
enqueue ──► delivering ──┬─► completed   （全部 unit 交付）
                         ├─► cancelled   （cancel / user interrupt / stop / superseded）
                         └─► failed      （adapter 报错或抛错 ⇒ 停止剩余）
```

* 每个 conversation **最多一条**活动队列；同会话再次 enqueue ⇒ 旧队列 `cancelled('superseded')`
  （新一轮生成意味着上一轮被顶上，与 user interrupt 同一语义）。
* 队列上限 `QUEUE_MAX=32`（有界，绝不随会话无限增长）；trace 上限 `TRACE_MAX=240`。
* 状态词表 `STATES=['queued','delivering','completed','cancelled','failed']` 是唯一真源。
* 每个 unit 严格串行交付（绝不并存两个在飞的 unit）：顺序稳定、不可能重复落库。

## 6. Timing contract

```
unit.delivery = { delayBefore?, typingDuration? }
时序：[静默 delayBefore] → [typing typingDuration] → unit 进入会话流
```

* 两端各自夹紧：`delayBefore ≤ 8000ms`、`typingDuration ≤ 6000ms`（总时长因此有上界）。
* 缺省值由**文本长度**确定性派生：`base + 字符数 × factor`（delay: 240+14n / typing: 180+18n），
  绝无 `Math.random()`、绝不读时钟。
* 显式值优先 —— 既有 producer（`MessagePresentation.plan` 的 `delay`）的节奏不被本模块改写。
* **首条 unit 在没有任何显式值时完全不等待**（legacy 单条路径 / fast path 的手感逐字不变）。
* 时间只能经注入的 `deps.now / deps.setTimeout / deps.clearTimeout` 流动；测试用假时钟，
  零真实 sleep。

## 7. Typing 行为

* 仍然只有**一套** typing UI：`div.chat-typing`（单聊 id = `chat-typing-<friendId>`）。
  创建/销毁收敛成 `_ibTypingOn / _ibTypingOff / _ibTypingFinish` 三个函数，生成期与交付期共用。
* 生成期文案 `名字 思考中…（N秒）`（含 1s 秒表，与改动前逐字一致）；
  交付期文案 `名字 正在输入…`（与 Cinema 同款）。
* 交付序：typing ON → 等 `typingDuration` → typing OFF → **消息才出现**。
* 清理：cancel / stop / 失败 / 完成 / 新回合顶替 / 错误路径都会走 `_ibTypingOff`；
  回到"仍在 typing 阶段"的会话时 `loadChatMessages` 会调 `_ibDeliveryTypingReassert()`
  把它重新画出来（面板重渲染会销毁 DOM，这不是第二套 UI）。
* Cinema 的 `.ci-typing` 由 `turn` 广播驱动，本阶段让 `turn end` 落在**交付完成**时，
  因此交付期间 Cinema 的 typing 与聊天窗口一致（超时兜底仍是它自己的 60s）。

## 8. Voice 行为

* voice unit 只在它自己的交付时刻出现（落库 + 渲染都在那时）。
* 播放继续走 Phase 1：`_buildVoiceEl` + `_vmResolveSrc` + `ibBridgeLoadAudio` + 单实例播放。
* **autoplay 天然发生在交付之后**：唯一的 autoplay 是"气泡进 DOM 后 1200ms 的文本→TTS"，
  未交付的 unit 没有 DOM 节点（本阶段**没有**新增任何 autoplay 机制）。
* 不可播放的 voice 在**构造期**就被拒（Phase 2A `unplayable-voice`，fail closed），
  根本进不了队列。

## 9. Cancel / user interrupt 语义

| 触发 | 行为 |
|---|---|
| 用户点 Stop | `stopStreaming()` 同时 `abort(activeConversation,'user_stop')`：停止生成 + 取消剩余交付 |
| 用户发新消息 | `sendChatMessage` 在写入用户消息后 `abort(conversation,'user_interrupt')`：取消剩余，**已交付的保留** |
| 同会话新 sequence | enqueue 时旧队列 `cancelled('superseded')` |
| 交付失败 | `failed`：停止剩余、保留已交付、不静默继续 |

**partial delivery preservation（硬要求）**：cancel 绝不删除已交付的消息 ——
它们已经是 canonical 事实。

本阶段**不做** resume：interrupt = cancel remaining（用户明确"不要复杂 resume"）。

## 10. 会话 / thread 隔离

* 队列按 canonical `conversationId`（含 threadId）绑定，不写死 friendId。
* 渲染与 typing 都过 `_ibConvIsActive(friendId,threadId)`（同时比较 friend 与 thread）——
  这修掉了改动前的真实缺陷：切到话题频道时，主对话的后续 unit 会被追加进话题列表。
* 切换会话**不破坏**已交付消息；pending 队列继续在后台按自己的时间线交付
  （落库继续、DOM 只在回到该会话时出现）。没有全局裸 timer：每条队列各自的定时器都在
  自己的 queue 对象上，`dispose()`/`abort()` 立即清掉。

## 11. Reload / crash 语义

**队列是 ephemeral 的内存状态，绝不恢复。** reload 后：

* 已交付 unit 仍在 canonical store（正常显示、可撤回、可检索）；
* 未交付 unit 随页面消失，不会"5 分钟后突然继续发"。

## 12. 失败语义

* `generation failure`（provider 调用失败）与 `delivery failure`（落库/渲染失败）是两件事：
  前者走既有错误模型，后者由 runtime 判 `failed`。
* 任一 unit 失败 ⇒ 停止剩余 sequence，保留已交付，**不 silent fallback**、不跳到 `#3`。
* adapter 抛错同样 fail closed（`unit-threw`）。

## 13. Context / Memory 隔离（硬验收线）

未交付 unit：不在 `chatMessages` ⇒ 不在 provider context、Memory、Search、Middle Brain
context、Diary、Role Letters、Home Node dialogue、Mobile DTO。
测试直接构造"只交付第 1 条"的状态，然后用 `dialogue-core` 的证据投影与 search/memory 取样
断言第 2 条**不存在**（`Q.*` / `R.*` / `P.*`）。

## 14. 修改文件

| 文件 | 改动 |
|---|---|
| `assets/js/delivery-runtime.js` | **新增**（队列/状态/时间/typing 开关/cancel；零 DOM、零存储、注入时钟） |
| `assets/js/communication.js` | 新增 Delivery adapter 区块（identity / typing authority / `_ibDeliverUnit` / `_ibStartDelivery` / `_ibDeliveryAbort` / `_ibDeliveryPending` / `_ibDeliveryTypingReassert`）；生成期 typing 收敛到 authority；waifu 多段改由 runtime 交付；user interrupt 与 stop 钩子；`turn end` 落在交付完成；导出接缝 |
| `assets/js/delivery-sequence-core.js` | id 的熵只由 `turnId` 决定 + 序号补零 ⇒ **按 id 升序 == 按 sequenceIndex 升序**（见 §16） |
| `InternalBeyond.html` | 新增一行 script（落在既有豁免脚本区段内） |
| `tests/test_delivery_runtime.js` | **新增**（A–Z + adapter 沙箱 + 契约守卫） |
| `tests/test_message_sequence_contract.js` | 更新 id 顺序断言（新语义更强） |
| `tests/test-all.js` | 登记新测试 |
| `docs/P23-2B-DELIVERY-RUNTIME.md` | **新增**（本文件） |

## 15. 测试

`node tests/test_delivery_runtime.js` → **160 项全绿**（零浏览器、零网络、零真实 sleep）：
A–Z 全覆盖，另含 supersede / 有界性 / 参数校验 / 分层守卫，以及
**真实 adapter 函数体沙箱**（12 个函数逐字抽出，用假 DOM + 假 store 执行：
落库、渲染、typing DOM 开合、会话与 thread 守卫、abort、typing 重画、单条 fast path）。

浏览器侧（真实页面 + 真实 Chrome + 真实 Home Node）：

* `test_chat_smoke.js --browser` —— **全部通过**，含 waifu 端到端 4.6 段
  （`waifu.onMultiMessages` / `onKeepsAll` / `onNoContentLoss` / `offSingleMessage` /
  `example1.exactly3` / `example1.lossless` / `example1.ordered`）；
* `test_boot_smoke.js` —— 11/11（页面加载、零未捕获异常）；
* `test_m1a_chat_authority_smoke.js --browser` —— chat / authority / mirror / fail-closed 断言全绿。

## 16. 本阶段发现的真实缺陷与本阶段的修复

1. **话题频道串消息**：交付期间切 thread，后续 unit 会被追加进话题视图。
   ⇒ `_ibConvIsActive` 同时比较 thread。
2. **交付停不下来**：Stop 只停 provider。⇒ 同一个 stop 入口取消剩余交付。
3. **用户插话被忽略**：A 已发、用户说"等等"、B/C 继续发。⇒ user interrupt 取消剩余。
4. **同毫秒 + 每段随机 id 造成的乱序（浏览器端到端实测抓到）**：
   Phase 2A 让同一回合共享 timestamp 后，未排序的读取点（`dbGetAll` = id 升序）会拿到乱序。
   ⇒ id 的熵只由 `turnId` 决定、序号补零，于是**存储层自然顺序 == canonical 顺序**。
   证据：`test_chat_smoke.js` 的 `waifu.example1.ordered/lossless` 由 FAIL 变 PASS。

## 17. 已知限制

1. `social.js` 与 `role-dm.js` 是冻结文件 ⇒ 它们的读取顺序不由本阶段接管（已被 §16.4 的 id 顺序兜住）。
2. 交付期间切换会话时，回到该会话**不会**重新播放已经过去的 typing 窗口（只在仍处于 typing 时重画）。
3. interrupt = cancel remaining，没有 resume（按用户要求）。
4. 队列不持久化：reload 即放弃未交付部分（按用户要求）。
5. 工具续轮（`_wsToolContinue`）仍**立即**交付（模型那一轮结束才产生该 unit），未纳入 timing 队列。
6. 群聊仍走既有"多人单聊串联"路径，本阶段零改动。
7. trace 是内存 ring（有界），不是持久日志（IB 已有 trace authority 不重复造）。

## 18. Phase 2C prerequisites

（P23 Phase 2C 已落地：`assets/js/delivery-planner.js` + 本轮实测见
`docs/P23-2C-DELIVERY-PLANNER.md` —— 它满足下面每一条，并额外证明了
"planner 只产出结构、不产出时间"。）

1. Planner 只能产出 Phase 2A 的 `sequence` 输入 + 本阶段的 `delivery` 提示，
   **不得**自行决定 id / 顺序 / 落库 / cancel 语义。
2. Planner 不得引入 `Math.random` 或依赖时钟的节奏；一切时间经 runtime 的注入时钟。
3. 若 Planner 要拆 voice/image，必须继续复用 Phase 1 canonical voice 契约（不建第二套 schema）。
4. 若要 resume / 持久队列，必须先证明 91 个读取点能安全忽略"未交付"行（否则不要做）。

## 19. 未来 Group Runtime 兼容

* 队列身份是 `conversationId`（`group:<id>…` 天然可用）+ `scope` 标注；runtime 不读 scope 做分支。
* `MessagePresentation` / 群聊"多人单聊串联"未被动过 ⇒ Group Runtime 可以在此之上设计
  "群回合 = 多个成员 sequence"，而 delivery 层已经准备好了每会话隔离、取消与 typing。
