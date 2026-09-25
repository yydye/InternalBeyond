# P23 Closure · Voice & Human-like Message Delivery（canonical freeze）

本文是 P23 的 **canonical closure 文档**：表达**最终事实**。
各阶段的过程报告（`docs/P23-1-…`、`P23-2A-…`、`P23-2B-…`、`P23-2C-…`、`P23-2D-…`）保持历史原样，
其中的阶段性"将来时"结论以本文为准（见 §17）。

状态：

```
P23 CLOSURE: PASS WITH NOTES
P23 COMMIT : BLOCKED BY WORKTREE OWNERSHIP（逻辑已冻结：P23 LOGICALLY FROZEN）
```

---

## 1. Scope

P23 交付的是**"一次模型回复如何变成本地会话里的多条人类式消息（含语音）"**这条链路：

```
Model Response
   ↓  Delivery Planner（结构：几段、边界在哪）
   ↓  Multimodal Delivery Policy（模态：text / voice；image 见 §13）
   ↓  Message Sequence Contract（identity / ordering / canonical unit 构造）
   ↓  Delivery Runtime（时间 / typing / 队列 / 取消）
   ↓  canonical chatMessages
   ↓  Voice / Text presentation（Phase 1 voice 契约）
```

**在范围内**：结构切分、模态决策、消息身份与顺序、交付时间与生命周期、typing、取消/插话、
语音消息的 canonical 形状与播放、移动端 DTO 的 voice 字段、以及这些能力的文档与测试。

**不在范围内（本阶段不做、已冻结为 deferred）**：AI 自动决定拆句（planner 用规则、不用模型）、
Group Runtime / groupTurnId / 群聊 brain 与 memory、image runtime、
streaming 多段与 streaming voice、主动消息策略重构、provider core 重构、DB migration、
可恢复（持久化）投递队列、Voice UI 触发点。

## 2. Architecture（最终形态）

| 层 | 唯一职责 | 唯一实现 |
|---|---|---|
| Voice Core | canonical voice 语义（形状/可播放/陈旧/清洗/生命周期原语） | `assets/js/voice-message-core.js` |
| Planner (2C) | **结构**：一段文本切成若干 delivery unit 的边界策略（无损、确定性、无时间） | `assets/js/delivery-planner.js` |
| Policy (2D) | **模态**：每个 unit 是 text 还是 voice（image 延后） | `assets/js/multimodal-delivery-policy.js` |
| Sequence (2A) | **identity / ordering**：unit → canonical chatMessage（id、回合身份、sequenceIndex、顺序） | `assets/js/delivery-sequence-core.js` |
| Runtime (2B) | **时间与生命周期**：队列、typing 开关、确定性等待、取消、会话隔离 | `assets/js/delivery-runtime.js` |
| Adapter | **集成**：落库、渲染、广播、voice 物化（TTS）、typing DOM、turn 广播 | `assets/js/communication.js`（P23 区块） |

依赖方向严格单向：Voice ← Sequence ← Runtime ← Adapter；Planner → Policy → Sequence。
**禁止存在第二份** splitter / modality decision / queue / voice schema / ordering authority（§4 有守卫）。

## 3. Frozen invariants（逐项对账，2026-09 实测）

图例：证据 = 测试用例名 或 源码位置（都取自**当前工作区**）。

| # | 不变量 | 状态 | 证据 |
|---|---|---|---|
| F1 | 一个 delivery unit = 一条 canonical chatMessage | ✅ | `delivery-sequence-core.buildMessages`（1 unit → 1 message）；`test_message_sequence_contract` A–E |
| F2 | 一次模型回合可以产出 N 条消息 | ✅ | waifu 多段与工具续轮两条生产路径；`test_message_sequence_contract` E/`test_delivery_runtime` B |
| F3 | `content` 是文本权威 | ✅ | 渲染走 `content`；voice 只附 `voice` 字段（`_buildMsgEl`/`appendChatBubble`）；`test_multimodal_delivery_policy` G |
| F4 | voice 是**附着的音频证据**，不替代 content | ✅ | `message = {content, voice}`；`voice.transcript === content`；`contentHash` 防陈旧（`test_voice_message_lifecycle` W/C） |
| F5 | 未交付的 unit **不是**会话历史 | ✅ | 队列只在内存（runtime），唯一落库点是 `_ibDeliverUnit`（communication.js:4473） |
| F6 | 只有已交付的 unit 进入 DB/Context/Memory/Search/对话证据 | ✅ | `test_multimodal_delivery_policy` P/Q/R；`test_delivery_runtime` P/Q/R |
| F7 | 用户插话取消剩余 unit | ✅ | `_ibDeliveryAbort(...,'user_interrupt')`（communication.js）；`test_delivery_runtime` J；`test_multimodal_delivery_policy` L |
| F8 | 已交付的 unit 一律保留 | ✅ | `delivery-runtime.abortQueue` 只终结队列、不触碰已交付；同一组测试的 I/L |
| F9 | 交付顺序确定性 | ✅ | `delivery-sequence-core.orderMessages` + id 可排序（熵由 turnId 决定、序号补零）；`test_message_sequence_contract` I/J |
| F10 | 不用 `Date.now()+i` 伪造顺序 | ✅ | 四个 P23 模块里 `Date.now() +` 零命中；多段共享同一 timestamp（`test_message_sequence_contract` G） |
| F11 | 不靠 `Math.random` 决定节奏 | ✅ | 四个 P23 模块**去注释后** `Math.random` 零命中；`test_delivery_runtime` E、`test_multimodal_delivery_policy` S |
| F12 | Planner 不改写内容 | ✅ | `test_delivery_planner` W / `test_multimodal_delivery_policy` W（拼接与逐条一致） |
| F13 | Policy 默认恒为 text | ✅ | 决策表 A/B/C（无意图/偏好 ⇒ 全 text；软偏好不升级纯文本） |
| F14 | capability ≠ preference ≠ intent | ✅ | capability/preference/intent 三输入分离；D/E 分别证明"有能力没偏好仍是 text"与"有偏好没能力降级" |
| F15 | voice 的 TTS 在 delivery time 物化 | ✅ | `_ibMaterializeVoiceUnit` 的唯一调用者是 `_ibBuildUnitAt`（communication.js:4699），后者只由 `_ibDeliverUnit`（runtime onUnit）调用 |
| F16 | 交付前被取消的 voice unit = 零 TTS 请求 | ✅ | `test_multimodal_delivery_policy` K/L（断言 `tts.calls.length === 0`） |
| F17 | 语音 provider 失败不触发 provider roulette | ✅ | 只有一处 `/api/tts` 调用点、无重试/换 provider；测试 N（`singleTtsEndpoint` / `noSecondProviderPath`） |
| F18 | 语音失败回落**内容完全相同**的文本 | ✅ | M 测试（3/3 到场、内容逐字一致、trace 记 `tts-failed`） |
| F19 | Runtime 与模态无关 | ✅ | `delivery-runtime.js` 里没有任何 kind 分支（`kind ==` / `=== 'voice'` 零命中） |
| F20 | 会话身份不写死 friendId | ✅ | runtime 以 canonical `conversationId` 为队列键（`_ibConvId` 派生自 chat-core）；带 `scope` 标注；测试 K/L |
| F21 | 存储真相 ≠ provider wire 表示 | ✅ | 相邻同 role 的合一只发生在请求构造边界（`IBModelCore.normalizeWireRoles` + `_ibWireMessages`）；DB 不动 |
| F22 | 不写 parent + child 双份 | ✅ | 没有 parent 行；`test_message_sequence_contract` X、`test_delivery_runtime` X |
| F23 | 秘密不进入 sequence metadata / runtime trace / policy trace / message metadata | ✅ | capability 消毒（闭集键、脏输入即判不可用）；两处 trace 键闭集；`test_multimodal_delivery_policy` Q、`test_delivery_runtime` Y |
| F24 | 旧单条路径保持兼容 | ✅ | 单条不经过 policy/timing（`test_multimodal_delivery_policy` U/X）；`test_chat_smoke` 的 `waifu.offSingleMessage` |

## 4. Cross-phase architecture audit（有没有重复权威）

| 检查项 | 结果 | 证据 |
|---|---|---|
| 第二份 splitter | ❌ 不存在 | `communication.js` 去注释后 `_tokenize/_beatsFromTokens/_segmentProse/_utterances/_splitLong/_antiFrag` **零命中**（`test_delivery_planner` WIRE 守卫） |
| 第二份 modality decision | ❌ 不存在 | 模态只在 `multimodal-delivery-policy.js`；adapter 只采集输入（`test_multimodal_delivery_policy` 结构断言） |
| 第二份 queue | ❌ 不存在 | 全仓唯一队列在 `delivery-runtime.js`；`_ibStartDelivery` 只是转调 |
| 第二份 voice schema | ❌ 不存在 | 只有 `voice-message-core.js`；sequence/policy/materializer 都不定义 voice 形状（2A 的 voice 单元仍经 `IBVoiceMessage.build`） |
| 第二份 ordering authority | ❌ 不存在 | 顺序只在 `delivery-sequence-core.orderMessages`；各处读取点只**转调**（`_ibOrderMessages` / `_ibOrderMsgs`） |

**结论：没有 duplicate authority → 不是 Closure Blocker。**

## 5. Canonical P23 file inventory（CORE / ADAPTER / TEST / DOC / SHARED）

**CORE（纯模块，唯一实现）**
`assets/js/voice-message-core.js`（P23-1）· `assets/js/delivery-sequence-core.js`（2A）·
`assets/js/delivery-runtime.js`（2B）· `assets/js/delivery-planner.js`（2C）·
`assets/js/multimodal-delivery-policy.js`（2D）· `bridge/tts.js`（TTS provider registry，P23-1）·
`bridge/voicebox.js`（本地 voice runtime 代理，P23-1）

**ADAPTER（集成面）**
`assets/js/communication.js`（P23 区块：wire 归一转调、顺序转调、typing authority、delivery adapter、
planner/policy 接线、voice 物化、实时语音气泡）· `assets/js/communication/voice.js`（语音条与取源）·
`assets/js/bridge.js`（`ttsPayload` / `fetchAiVoiceDataUrl` / `probeAudioDuration` / autoplay 接缝）·
`assets/js/mobile-dto.js`（voice/回合身份 DTO）· `services/home-node/chat-store.js`（取页后回合归组）·
`services/ib-bridge-service.js` · `bridge/config.js` · `bridge/routes.js` · `InternalBeyond.html`（脚本与 Voice 卡片）

**TEST**
`tests/test_voice_source.js` · `test_native_voice_message.js` · `test_voice_playback_path.js` ·
`test_voice_message_lifecycle.js` · `test_voicebox_provider.js` ·
`test_message_sequence_contract.js` · `test_delivery_runtime.js` · `test_delivery_planner.js` ·
`test_multimodal_delivery_policy.js` · `tests/test-all.js`（登记）

**DOC**
`docs/P23-1-VOICE-RUNTIME-FOUNDATION.md` · `docs/P23-2A-MESSAGE-SEQUENCE-CONTRACT.md` ·
`docs/P23-2B-DELIVERY-RUNTIME.md` · `docs/P23-2C-DELIVERY-PLANNER.md` ·
`docs/P23-2D-MULTIMODAL-DELIVERY-POLICY.md` · `docs/CHAT_MESSAGE_CONTRACT.md`（§4.1 / §9）· `docs/P23-CLOSURE.md`（本文）

**SHARED（与其它 batch 共处同一文件，但 P23 部分是加法）**
`assets/js/communication.js`（M1 的接缝已随 be914b2 提交；当前工作树里该文件的改动**全部属于 P23**）·
`assets/js/{active-diary,core,ib-model-core,image-edit,memory,workspace}.js`（P23 加法）·
`assets/css/core/chat.css`（P23-1 语音气泡样式）· `assets/js/social.js`（P23-1 Voice UI 区段）·
`docs/CHAT_MESSAGE_CONTRACT.md` · `tests/test-all.js`

## 6. Cross-phase contract audit（层级职责）

* Planner 只做结构：不产时间、不落库、不调 TTS/模型（`test_delivery_planner` purity 守卫，去注释后无 `Date.now`/`Math.random`/DOM/网络）。
* Policy 只做模态：不产音频、不产时间（`test_multimodal_delivery_policy` S–V）。
* Sequence 只做 identity/ordering/构造：不排队、不定时（`test_message_sequence_contract` 全量）。
* Runtime 只做时间/队列/生命周期/取消：与模态无关（F19）。
* Adapter 只做集成：落库、渲染、广播、物化（唯一 `dbPut('chatMessages', m)` 交付点）。
* Voice Core 只做 canonical voice 语义：policy/adapter 都不定义 voice 形状。

## 7. Deferred items（正式冻结为"非 P23 closure blocker"，并逐项验证过不破坏不变量）

| 项 | 为什么不破坏当前不变量 |
|---|---|
| IMAGE runtime | 2A 仍 `RESERVED` 并拒绝 `image`；Policy 识别并降级/记账（`image-deferred`），不产生半套 image 形状 |
| streaming 多段 / streaming voice | 流式仍单条（`plan(...,{streaming:true}).mode==='stream'`），不经过 planner/policy；不变量只在"完整回合"上声明 |
| group turn identity / Group Runtime | 群聊路径未被本阶段触碰；runtime 身份是 conversationId（group 前缀可用），只缺 group 语义设计 |
| pagination vs turn boundary | Home Node 取页后归组（`base:'given'`），分页锚点语义未改；桌面读取是整会话读 |
| `social.js` / `role-dm.js` 读取顺序 | 二者被其它阶段的守卫冻结；已被"id 顺序 == sequenceIndex 顺序"兜住（2A 的 id 方案） |
| tool-round 立即交付 | 工具续轮是**增量**写入（unit 在那一刻才存在），仍经 2A 构造并带回合身份；不经过 timing 队列 |
| Voice UI 触发点 | 默认恒为 text，因此没有触发点也不产生行为变化；显式意图/配置是程序化入口 |
| 可恢复投递队列 | 队列 ephemeral 是 §13 的既定选择；不恢复就不会与 F5/F6 冲突 |

## 8. Documentation changes

* **新增**：`docs/P23-CLOSURE.md`（本文，canonical）。
* **历史报告保持原样**（`P23-1` / `2A` / `2B` / `2C` / `2D`）：它们记录的"当时状态/将来时"不改写。
* 被本文**取代**的阶段性表述（历史文档里仍能看到，但以本文为准）：
  1. 2A 文档曾把 "Mobile DTO 缺 `audioUrl`/`provenance`" 记为缺口 —— 已在 2A 闭合（phase 1 的登记项）。
  2. 2B 文档的"已知限制"里，`social.js`/`role-dm.js` 顺序未接管仍然是事实，但影响已被 2A 的 id 顺序方案降到"无乱序可见"。
  3. 2C 文档的"生产路径仍经 strings → `_ibSequenceMessages`"在 2D 之后有第二条入口（voice 物化的前缀构造）；两处都经 2A 构造，见 2C §2.1 与 2D §7。
  4. 2D 文档的 "READY FOR CLOSURE" 现已由本文正式收口。

## 9. Storage semantics（最终）

* canonical 存储仍是 `chatMessages`（Home Node 权威 + 浏览器镜像），**本阶段零 migration**；
* 一条 delivery unit 落一条消息；同一回合共享 `metadata.turnId` 与同一个 `timestamp`，顺序由 `sequenceIndex` +
  "按 id 升序 == 按 sequenceIndex 升序"的 id 方案保证；
* 未交付 unit 只存在于内存队列（F5/F6）；
* **voice 的 TTS 只发生在 delivery time**，且失败时以同内容文本落库（F15/F18）。

## 10. Voice semantics（最终）

`content` 是文字稿权威；`voice` 是附着的音频证据（`dataUrl` 或 Bridge `/tts/<id>.<ext>` 引用至少其一）；
provenance 走 Phase 1 白名单清洗；`contentHash` 一旦与 content 不符即判定陈旧，
撤回/续写/编辑必须走 `dropVoice`（immutable：删音频而不是改文字稿）。
播放唯一路径：`_buildVoiceEl` → `_vmResolveSrc` → `ibBridgeLoadAudio`（Bridge 引用必须 fetch→blob）。

## 11. Planner semantics（最终）

规则型、确定性、无损；结构保护（代码块/inline code/markdown 链接·图片/URL/成对括号/JSON·列表/
`**…**`·`__…__`·`~~…~~`/`[sticker:…]`·`[music:…]`）与功能标签整条不拆；
边界优先级：空行 > 句读（。！？!?）> 逗号+转折词 > 长度控制；
长度策略：`MIN_UNIT_CHARS=4`、`MAX_UNIT_CHARS=96`（硬上界）、`MAX_UNITS=60`、默认段数上限 30（长度优先）；
`hints.style` 只移动硬上界（64/160），绝不改写内容。

## 12. Delivery semantics（最终）

`delayBefore`（静默间隔）→ typing（`typingDuration`）→ unit 进入会话流；
两端夹紧（8s / 6s），默认节奏由文本长度确定性派生；首条无显式值时完全不等待；
typing 只有一套 DOM 实现（`chat-typing` + id 约定），生成期与交付期共用；
`turn end` 广播落在交付完成时（Cinema 的 typing 因此跟着交付走）；
cancel / interrupt / supersede / failed 的语义见 2B 与 F7/F8/F16/F17/F18。

## 13. Security boundaries（最终）

1. policy/planner 只看得到"能力可用性"（capability 是构造式白名单 + 脏输入 fail closed），看不到任何凭据；
2. sequence 输入任何一层出现凭据形状 ⇒ 整批不产出（2A）；
3. runtime trace / policy trace 键闭集（身份 + 模态 + 原因），无正文、无音频；
4. 移动端 DTO 只发 `audioUrl`（Bridge 引用形状）与 provenance 白名单，绝不发 `dataUrl`；
5. message metadata 未新增任何字段（无凭据位）。

## 14. Compatibility guarantees

* **旧单条路径**：`waifu=false` 或单段回复仍是一条消息，逐字同形（F24）；
* **旧消息**：无 `turnId` 的旧行按 `(timestamp, id)` 排序，不补键、不改形状；
* **旧导出/导入**：整体复制 payload，新增键（回合身份）原样往返；
* **provider**：wire 只在需要交替的 format（gemini）合并，存储不受影响（F21）；
* **voice**：Phase 1 契约完全保留（形状、播放、陈旧、撤回）。

## 15. Test evidence

**Focused closure suite（本轮实测，P23-only checkout 与工作区都跑过）**

| 测试 | 结果 |
|---|---|
| `test_message_sequence_contract.js` | 166 通过 |
| `test_delivery_runtime.js` | 160 通过 |
| `test_delivery_planner.js` | 224 通过 |
| `test_multimodal_delivery_policy.js` | 103 通过 |
| `test_voice_message_lifecycle.js` | 68 通过 |
| `test_voice_playback_path.js` | 70 通过 |

**更大范围（引用各阶段 freeze 时已完成的实测，不在本轮重复）**：`test_native_voice_message` 86 ·
`test_voice_source` 47 · `test_chat_core_contract` 91 · `test_moments_acl_contract` 66 ·
`test_disclosure_authorization` 206 · `test_astra_readiness_observe` 0 failed · `scripts_check_html` 122/0 failed ·
浏览器：`test_chat_smoke`（真实页面 + waifu 端到端）全绿 · `test_boot_smoke` 11/11 ·
`test_moments_phase4_smoke.waifu.splitRules` ✔ · `test_m1a_chat_authority_smoke` 的 chat/authority/mirror 断言全绿。

## 16. Known baseline failures（PRE-EXISTING / OUT OF P23 SCOPE）

`node tests/test-all.js --quick` 在 2D freeze 时：`static 120 · 6 失败`，`p22-ui` 全绿。六条红项与 P23 无关，已冻结为既存状态：

1. `test_frontend_structure`：5 条 BOM 失败，全部落在**未被 P23 触碰**的 economy/home-node 文件；
2. `test_middle_brain_convergence_counterproof`：`base.copyClosureIsComplete` fixture 在 HEAD 上已红（缺 P22 的依赖边）；
3. `test_home_node_client_envelope`：HEAD 上同样 1 条失败；
4. `test_anthropic_wire_contract`：与 git-ignored 的 `Economy-v1-release/` 暂存副本重名匹配；
5. `test_installer`：缺少 `runtime/node/node.exe` 等 payload 前置；
6. `test_update_card`：断言 `test_frontend_structure` 全绿（被第 1 条带红）。

**禁止**在 P23 范围内修这些（除非将来证明由 P23 引起）。

## 17. Change rules after freeze

1. **P23 的五个核心模块**（voice/sequence/runtime/planner/policy）与其契约进入冻结：
   任何语义修改都必须走**显式 contract revision**（新阶段文档 + 测试更新 + 报告），不得"顺手改"。
2. `communication.js` 的 P23 区块只允许**加法**：新消费点必须复用既有入口
   （`_ibStartDelivery` / `_ibMmResolve` / `_ibSequenceMessages` / `_ibOrderMessages`），
   禁止新增第二份拆句、模态判断、排序或队列。
3. 触碰实现之前必须先动测试：任何不变量（F1–F24）的修改都必须先改对应测试再改实现
   （先让断言表达新语义，再改代码）。
4. `social.js` / `role-dm.js` 仍由其它阶段的守卫冻结（见 §7）；解除需要那两个守卫的 owner 同意。
5. 新增语音 provider / image unit / streaming 多段 / group 语义 **不得**改写既有五个模块的契约，
   只能在其之上新增（例如 P24 的 group 身份层）。

## 18. P24 handoff contract（Group Runtime）

P24 **可以使用**（且不应重新实现）：

```
Group Member Turn
   ↓ Delivery Planner（结构）
   ↓ Multimodal Policy（模态）
   ↓ Sequence Contract（identity/ordering）
   ↓ Delivery Runtime（时间/取消/typing）
```

P24 **可以新增**：`groupTurnId`、参与者身份、发言规划（participation planning）、角色间可见性、
Group Brain、插话、群聊上下文/记忆。

P24 **不应该重新实现**：message splitter、sequence ordering、delivery queue、
typing scheduler、voice message schema、TTS materialization、modality policy。

如果 P24 需要破坏 F1–F24 中的任何一条：必须走**契约修订**（文档 + 测试 + 报告），
而不是就地修改冻结层。

## 19. Commit status（本轮）

**COMMIT: BLOCKED BY WORKTREE OWNERSHIP。** 理由与证据：

* P23 自有文件可以**干净隔离**（本轮在临时 worktree 里做过实验：HEAD + 仅 41 个 P23 文件 ⇒ 六个 focused 测试全绿）；
* 但 P23 的两个**守卫前置**属于其它在途 batch，且其 P23 相关部分与那些 batch 的工作**不可 hunk 级分离**：
  * `tests/test_astra_readiness_observe.js`（Astra 会话；`P23_VOICE_UI_ONLY` 豁免混在单个 375 行 hunk 里）；
  * `tests/test_disclosure_authorization.js`（disclosure 会话；`W5b` 重写是单个 291 行 hunk）。
  在同一临时 worktree 里用**这两个文件的 HEAD 版本**跑守卫：Astra `1 failed`、disclosure `W5b FAIL` ——
  也就是说，单独提交 P23 会产生一个"自己的守卫在干净检出里是红的"提交；
  而整文件提交这两个测试会把其它会话未完成的 batch 一起带进来（违反 §12(C)/§13）。
* 因此本轮**没有创建 commit**，也没有 stage 任何内容（索引保持干净，其它 batch 字节零损失）。

解封条件（任一即可）：那两个守卫文件由各自 owner 提交；或由 owner 明确同意把它们的 P23 相关修订并入 P23 closure commit。

---

**P23 逻辑冻结**：`P23 LOGICALLY FROZEN`（契约与实现已冻结，提交因工作树所有权延后）。
