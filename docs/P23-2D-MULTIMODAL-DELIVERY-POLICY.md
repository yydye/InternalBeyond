# P23 Phase 2D · Multimodal Delivery Policy

Phase 2D 只回答一个问题：**一个 delivery unit 是 text、voice，还是 image。**
它不拆句（2C）、不排序/不落库（2A/2B）、不合成音频（Phase 1）、不调模型。

```
Model Response → (2C Planner: 结构与分段) → (2D Policy: 每条 unit 的**模态**) →
(2A Sequence Contract: identity/sequence) → (2B Delivery Runtime: 时间/typing/cancel) →
(Phase 1 voice contract: voice message/playback) → canonical chatMessages
```

状态：`PASS WITH NOTES`（image DEFERRED；voice 触发点仍是 programmatic，UI 留后续）。
**P23 READY FOR CLOSURE**（见文末）。

---

## 1. Phase 0 audit

### A. Voice（现状，源码为准）

| 部件 | 事实 |
|---|---|
| `assets/js/voice-message-core.js` | canonical voice 契约：`build / hasPlayable / playSrc / isStale / dropVoice / sanitizeProvenance / findSecret`；voice 对象形状 `{dataUrl, audioUrl, mime, duration, transcript, contentHash, provenance}` |
| Bridge TTS | `bridge/tts.js` + `bridge/routes.js:POST /api/tts`（provider：edge / openai 兼容 / MiMo / **Voicebox**）。返回 `{ok, id, url:'/tts/<id>.<ext>', bytes, ext, mime, …}`（**没有 duration 字段**） |
| payload 组装 | `bridge.js:_ibTtsPayload` → 对外唯一入口 `IB.bridge.ttsPayload(vc,text)`；凭据由 Bridge config.json 提供，payload 里没有 apiKey |
| 取回音频 | `bridge.js:_ibFetchAiVoiceDataUrl`（fetch → blob → dataURL，超过 `INLINE_MAX_BYTES` 则不内联）与 `_ibProbeAudioDuration`（Audio metadata 探时长）。P23 2D 把它们**从私有提升为** `IB.bridge.fetchAiVoiceDataUrl / probeAudioDuration`（同一实现，零改动行为） |
| voice config | 角色记录 `cfg.voice = {enabled, provider, source, voiceId, rate, pitch, autoPlay, model, language, style, voiceType, voiceData}`；**没有** endpoint/apiKey（Phase 1 的 source 是引用） |
| 现成的"文字 → 语音消息"路径 | `bridge.js:_ibPersistAiVoice(bubble, tts, transcript)`：**先有消息、后有音频** —— 用户点播放或 `voice.autoPlay` 自动触发 `/api/tts` 成功后，把音频**贴到已存在的那条消息上**（`m.voice = …` → `dbPut` → 就地换成语音气泡） |
| voice 播放 | `_buildVoiceEl` + `_vmResolveSrc`（Bridge 引用必须经 `ibBridgeLoadAudio`）+ 单实例播放；`_ibAiVoicePayload` 是唯一的"这条消息该画成语音吗"判定（陈旧/撤回/不可播放一律回落文本） |

### B. Image（穷举后的结论）

| 面 | 事实 |
|---|---|
| message schema | `message.images = [{dataUrl, base64, mime, name}]` —— **内联数组**，没有独立 image 契约模块、没有 provenance、没有版本 |
| 生产者 | 用户上传（`sendChatMessage` 的 `sentImages`）；生成的图片（`_wsCollectGenImages` 从 `<ws_gen_image>` 工具结果收集，工具在 workspace/Image Router 层）；图片编辑产物 |
| 消费面 | 渲染（`_buildMsgEl`/`appendChatBubble` 的 `m.images` 分支 + 全屏查看器）、撤回（`delete m.images`）、存储计量、`site-operations.js` 的"清除图片"、
Mobile DTO（**只发元数据**：mime/name/size/inline 布尔）、导出/导入（整体复制 payload） |
| Image Router / 生图 | 独立配置与路由（角色自己的 imageGen 配置 + image-models-core/image-router*），属**工具调用**层；不是 delivery 层 |
| Sequence 侧 | Phase 2A 把 `image` 列为 `RESERVED_KINDS` 并**确定性拒绝**（`unsupported-kind:i:image`） |

### C/D/E. Planner / Sequence / Runtime

* Planner（2C）：`planTurn` 只产出 **text** units（`{kind:'text',content}`），并且**不产出任何时间**；
  `toSequenceInput` 是 plan → 2A 输入的唯一转换点。
* Sequence（2A）：`SUPPORTED_KINDS=['text','voice']`，`RESERVED_KINDS=['image']`；voice unit 必须**在构造时**带可播放音源（否则 `unplayable-voice` 整批拒绝），`content` 是文字稿权威，secret 形状整批拒绝。
* Runtime（2B）：**modality-agnostic** —— `delivery-runtime.js` 里没有任何 kind 分支（只有注释提到 kind 归属别的层）；`onUnit` 支持异步返回（Promise），这正是 2D 做 delivery-time 物化所需要的接缝。**2D 没有改 runtime 一个字节。**

### Phase 0 的七个问题与答案

1. **Phase 1 voice contract 的 canonical authority** = `assets/js/voice-message-core.js`
   （形状 + 可播放判定 + 陈旧判定 + 清洗 + `dropVoice` 生命周期原语），持久化在 `chatMessage.voice`。
2. **voice message 是"文本消息 + 附着的音频"**，不是"audio + 独立文字稿"：
   `content` 是权威文字稿，`voice.transcript` 与它同源（`contentHash` 保证一旦 content 变化就判定陈旧）。
   证据：`_ibPersistAiVoice` 是在**已存在的消息**上加 `voice`；`getTextContent`/上下文映射只读 `content`。
3. **2A 对 `kind:'voice'` 的支持程度**：完整 —— validate 要求音源可播放、`content` 必填、
   provenance 走 Phase 1 清洗、id/回合身份/顺序与 text 一致。
4. **image 是否已有 canonical chatMessage representation**：只有 `message.images` 内联数组；
   没有 image 单元契约、没有 provenance、没有存储权威、且 2A 明确拒绝 `image` kind。
5. **image 是否适合在 2D 直接接入**：不适合 ⇒ **IMAGE DEFERRED**（见 §4）。
6. **当前哪个模块调 TTS、什么时候调**：`bridge.js`（`_ibTtsSpeakImpl` → `/api/tts` → `_ibPersistAiVoice`），
   触发点是 **DOM attach 之后**（`ibObserve` 的 MutationObserver → `ibAttachTts` → `voice.autoPlay` 1.2s 入队 / 用户点击）。
   也就是说它已经在"接近 delivery"的一侧，但**是"消息已落库之后再把音频贴上去"**的路径，不是"born as voice"。2D 新增的是后者。
7. **voice config 能否安全判断 VOICE_AVAILABLE**：可以。`cfg.voice` 本身不含凭据
   （source 是引用；endpoint/apiKey 在 Bridge config.json），离线可判定 `enabled + voiceId + clone refAudioId`；
   policy 只接受**消毒视图**（白名单标量键），且对含凭据形状的输入 fail closed（`sanitizeCapability`）。

**Phase 0 结论：没有设计冲突，可以继续。**

## 2. Ownership audit

| 区域 | 归属 | 本阶段 |
|---|---|---|
| `delivery-runtime.js`（2B，冻结） | 2B | **未改一个字节**（layer 守卫断言） |
| `delivery-sequence-core.js`（2A，冻结） | 2A | 未改（只被调用） |
| `delivery-planner.js`（2C，冻结） | 2C | 未改语义（仅把 `style` 局部名重命名，避开 frontend_structure 的 inline-style 计数假阳性） |
| `assets/js/bridge.js` | **P23-1（未提交批次）** | 只做**加法**：把两个已存在的私有助手（inline 取回 / 时长探测）提升进既有 `IB.bridge` 导出对象（+5 行，零行为改动） |
| `assets/js/communication.js` | 多批次共享（P23-1 / M1 / 2A / 2B / 2C） | 只做加法：2D adapter 区块 + 交付适配（lazy 构造）+ 实时语音气泡渲染 + policy 接线 |
| `role-dm.js`（W5b 冻结）/ `social.js`（W5b + Astra 冻结）/ Astra READONLY_PROFILE / disclosure cores | 其它批次 | 不碰 |
| 新增 | `assets/js/multimodal-delivery-policy.js`、`tests/test_multimodal_delivery_policy.js`、本文件 | 本阶段 |

纪律：未使用 `git checkout --` / `git reset --hard` / `git clean`；对 `bridge.js` 的改动前做了字节备份与 SHA-256 校验
（备份文件 `%TEMP%/ib-bridge-before-2d.bak`，哈希与改动前逐字节一致）。

## 3. Voice canonical authority（本阶段如何复用）

2D **没有**新建任何 voice 形状：

* 决策层只输出 `kind:'voice'` + `content`（文字稿）；
* 音频物化只回**音频证据**（`dataUrl/audioUrl/mime/duration/provenance`）；
* canonical voice 对象仍由 **Phase 2A** 构造（内部调用 `IBVoiceMessage.build`）；
* 播放/陈旧/撤回仍走 Phase 1（`_ibAiVoicePayload` / `isStale` / `dropVoice`）。

## 4. Image canonical authority / deferred decision

**IMAGE DEFERRED TO P23.x**，理由（§1B 的证据）：
缺 canonical image unit contract（2A 明确保留并拒绝）、缺 provenance、缺存储权威
（内联 base64 直接躺在消息里，没有去重/迁移/回收策略）、
且生成属于工具调用层而不是 delivery 层。**不为了满足标题新建半套 image runtime。**
contract 侧只做三件事：
1. `MBImage`/`IMAGE_CAPABILITY` 明确登记"现在不可用、原因、延后到 P23.x"；
2. `resolve()` **识别** `kind:'image'`：有正文 ⇒ 降级为同内容 text（`image-deferred`），无正文 ⇒ 记为 dropped，
   **绝不静默丢失内容**；
3. 未来接入时只需在 planner/policy 的 unit 里产出 `kind:'image'` —— 现有的
   `toSequenceInput`/序列构造/交付链已经允许 kind 透传，无需重写 2D。

## 5. Chosen policy architecture

**Planner → Policy → Sequence Input**（用户给的第一种顺序），即：结构先定、模态后定。

```js
IBMultimodalPolicy.resolve(units, ctx) → {
  units:[{kind:'text'|'voice', content}],       // 不含音频、不含时间
  decisions:[{index, requested, resolved, reason, canVoice, unitIndex}],
  stats:{inputUnits, outputUnits, voiceRequested, voiceResolved, downgraded, upgraded,
         imageDeferred, dropped, lossless}
}
```
唯一实现：`assets/js/multimodal-delivery-policy.js`（纯函数、零 DOM / 零存储 / 零网络 / 零时钟 / 零随机 / 零 TTS）。
`communication.js` 的 `_ibMmResolve` 只做输入采集与转调；**没有任何第二处决定模态**
（Middle Brain 不判断、communication 不判断、voice runtime 不猜）。

## 6. Capability / preference / intent contract

三者**分开**（这是"Voice capability ≠ Voice preference"的落地）：

| 输入 | 含义 | 本阶段来源 |
|---|---|---|
| `capability.voice.available` | 角色有没有**能工作**的 voice backend（消毒视图） | `_ibVoiceCapability(cfg)`：`enabled + voiceId (+ clone 需 refAudioId)`，离线可判定 |
| `preference.voice` | 角色/用户**希望**用 voice（软偏好） | `cfg.voice.replyDelivery === 'voice'`（**本阶段没有 UI 写入它**） |
| `intent.voice` | 这次**明确要求** voice（强意图） | `window.__ibMultimodalIntent`（程序化接缝；UI 留后续） |
| `hints.preferVoice` | 上层（未来 MB）的**偏好提示** | planner 的 hints 通道（可透传） |
| `policy.voice='off'` | 显式关闭（最高优先级） | 调用方显式传入 |

决策表（唯一公式）：

```
输入 kind=voice  → policy off ⇒ text(voice-disabled-by-policy)
                  !canVoice  ⇒ text(intent ? voice-intent-unmet : voice-unavailable)
                  预算用尽    ⇒ text(voice-budget-exceeded)     预算 = 3/回合
                  否则        ⇒ voice(voice-enabled)
输入 kind=text   → 仅**显式意图**可升级：intent && canVoice && !off && 预算 ⇒ voice(voice-enabled)
                  软偏好**不**升级纯文本（默认恒为 text 的硬兼容线）
                  其他 ⇒ text(default-text)
输入 kind=image  → text(image-deferred) / 空正文 ⇒ dropped(empty-unit)
```

## 7. Voice materialization boundary

**TTS 在 delivery time 发生**，位置 = `communication.js` 的 adapter（`_ibDeliverUnit` → `_ibBuildUnitAt` → `_ibMaterializeVoiceUnit`）。

* Planner / Policy **纯模块**，绝不调用 TTS（有源码守卫断言）；
* **不是"sequence 创建时把未来音频全生成"**：未交付的 unit 永远不会触发 `/api/tts`
  ⇒ interrupt / cancel / 放弃的 unit **零成本**（K/L 有测试）；
* 复用 Phase 1 的单实现部件：`IB.bridge.ttsPayload` → `POST /api/tts` →
  `IB.bridge.fetchAiVoiceDataUrl`（inline 上限判定）→ `IB.bridge.probeAudioDuration`（真实时长）；
* **canonical 消息在哪构造**：voice unit 的音频在 delivery time 才有，而 2A 要求 voice unit 构造即带音源。
  于是用**前缀构造**：把已交付/正在交付的 unit 一起交给 2A，取最后一条 ——
  id / `sequenceIndex` / 回合身份**仍只由 2A 决定**（adapter 绝不自己拼 id）。
  唯一让步：`metadata.sequenceTotal` 在前缀构造里算不出总数，**直接不写**（2A 已声明它是 advisory、读取方以消息集合为准）。
* **2B 冻结契约未被修改**：runtime 的 `onUnit` 本来就允许返回 Promise（异步 sink），
  materialization 只是在这个既有的异步窗口里多做一件事；queue/cancel/typing/persistence timing 一字未动。

## 8. Voice failure semantics

选 **B：确定性降级为同内容 text**（不是"整段失败"，也不是 provider roulette）。理由：
voice 只是**交付形式**，不是内容；§18 的硬线要求"任何异常都不能让 assistant reply 消失"，
而 2B 的 `failed` 语义（停止剩余）会把后面的 unit 一起牺牲掉。
降级满足 §9 的全部要求：

* content **完全一致**（同一条 unit 的同一字符串，测试 `M.failure.contentIdentical`）；
* **不**静默 provider fallback、**不**换 provider（`N.roulette.singleTtsEndpoint` + 源码里只有一处 `/api/tts`）；
* trace 明确记录 `requested=voice / resolved=text / reason=tts-failed|materializer-threw|tts-unavailable|…`；
* 不产生重复消息（`P.noDup.*`：一条 unit 只落一条）；
* 降级后**剩余 unit 继续交付**（M 测试断言 3/3 都到场）。

## 9. Cancellation / cost behavior

* `cancel`（Stop）与 `user interrupt`（新一轮发言）都由 2B 的 abort 处理；
  未交付的 voice unit 从未被物化 ⇒ **零 TTS 请求**（K/L 断言 `tts.calls.length === 0`）；
* 已交付的保留（partial delivery preservation，2B 语义不变）；
* 定时器在终结态清理（`clock.pending() === 0`）。

## 10. Planner integration

* Planner（2C）**未改**：仍只产出 text units 与结构；不生成音频、不调 TTS、不调 image API；
* Policy 在 planner 之后运行，只改 `kind`（text ⇄ voice），**绝不改台词**：
  `W.plannerLossless` / `W.policyDoesNotRewrite` 断言拼接与逐条内容与 planner 输出一致；
* 生产接线：waifu 多段分支里先 `_ibMmResolve(...)`，若无 voice ⇒ 走 2C/2A/2B 的既有 text 路径（逐字同形）；
  有 voice ⇒ 走 materialization path。单条（waifu off）路径**完全不经过 policy**。

## 11. Runtime integration

* runtime 保持 modality-agnostic：queue/typing/顺序/取消/会话隔离全部复用；
  **没有第二套 queue**（layer 守卫断言 runtime 文件里没有 kind 分支）；
* 2D 只往 `onUnit` 里加了一步"必要时物化音频 + 按前缀构造 canonical 消息"；
* text → voice → text：`sequenceIndex` 0/1/2、顺序、typing、cancel、隔离全部保持（J 测试）。

## 12. Middle Brain extension point

* MB 仍**不接**。唯一通道是既有的 `opts.hints`（2C 建立）——`hints.preferVoice` 在本阶段是
  **偏好输入**（软偏好），不是命令；
* MB **永远不能**写 chatMessages / 调 TTS / 调 runtime / 创建音频；
* policy 里没有一处提到 Middle Brain / `IB.middleBrain`（结构断言），因此"MB 直接控制模态"在结构上不可能。

## 13. Context / memory behavior

* voice message 的 `content`（文字稿）照常进入 provider context / Memory / Search / 对话证据（2A 的 `content` 权威不变）；
* 音频（`dataUrl`/`audioUrl`）**不进入** LLM context（历史映射只读 `content`；Phase 1 已如此）；
* queued voice unit 在交付前**不在 DB**，因此不在 context / Memory / Search（2B 的结构性保证，2D 未削弱）。

## 14. Security findings

* policy / planner 只看得到**能力可用性**与展示用元数据；`sanitizeCapability` 是构造式白名单，
  键闭集 `{available, reason, source, provider, engine, voiceId, voiceType, model}`；
* 含凭据形状（`apiKey` / `token` / `Bearer …` / `sk-…`）的能力对象 ⇒ **整块判为不可用**（fail closed），
  且不会被写进决策或 trace（`Q.*` 断言）；
* trace 只放 `{turnId, conversationId, unitIndex, requested, resolved, reason}`，**无正文、无音频、无凭据**；
* sequence metadata 与 message metadata 未新增任何字段（无凭据位）；
* 凭据形状的正文仍被 2A 在落库前拦住（`Q.sequence.rejectsSecretShape`）。

## 15. Modified files

| 文件 | 改动 |
|---|---|
| `assets/js/multimodal-delivery-policy.js` | **新增**（决策表 + 能力消毒 + trace + image deferred 契约） |
| `assets/js/communication.js` | 2D adapter（capability / intent / resolve / materializer / `_ibBuildUnitAt`）+ 交付适配（lazy 构造、voice 气泡实时渲染）+ waifu 分支 policy 接线 + 导出接缝 |
| `assets/js/bridge.js` | 仅加法：`IB.bridge.fetchAiVoiceDataUrl / probeAudioDuration`（复用同一实现） |
| `InternalBeyond.html` | 新增一行 script（落在既有豁免脚本区段内） |
| `tests/test_multimodal_delivery_policy.js` | **新增**（A–Z） |
| `tests/test_message_sequence_contract.js` | 更新一处源码形状断言（2D 让多段构造入口变成两个，断言改为"两者都经 2A 构造"） |
| `tests/test-all.js` | 登记新测试 |
| `docs/P23-2D-MULTIMODAL-DELIVERY-POLICY.md` | **新增**（本文件） |

## 16. Focused tests

`node tests/test_multimodal_delivery_policy.js` → **103 项全绿**：
A–I 决策表与形态 · J 全链路（policy→adapter→2A→2B，含 sequenceIndex/身份/文字稿/顺序/共享时间戳）·
K/L 取消与插话**零 TTS** · M 物化失败确定性降级（含抛错路径）· N/O 无 provider roulette / 无 speechSynthesis ·
P 无重复消息 · Q 秘密消毒 · R 50 次确定性 · S–V 纯模块守卫 · W planner 无损 · X 单条 legacy ·
Y streaming 未受影响 · Z image deferred 契约。

## 17. Related regression

`test_delivery_planner` 224 ✔ · `test_message_sequence_contract` 166 ✔ · `test_delivery_runtime` 160 ✔ ·
`test_voice_message_lifecycle` 68 ✔ · `test_voice_playback_path` 70 ✔ · `test_native_voice_message` 86 ✔ ·
`test_voice_source` 47 ✔ · `test_chat_core_contract` 91 ✔ · `test_moments_acl_contract` 66 ✔ ·
`test_disclosure_authorization` 206 ✔ · `test_astra_readiness_observe` 0 failed ✔ ·
`scripts_check_html` 122 scripts 0 failed ✔ · `test_frontend_structure` 仅剩 5 条**既存** BOM 失败（与本阶段无关）✔ ·
浏览器：`test_chat_smoke`（真实页面 + 真实 waifu 端到端）**全绿** ✔ · `test_boot_smoke` 11/11 ✔ ·
`test_moments_phase4_smoke` 的 `waifu.splitRules` ✔。

## 18. Test-budget compliance

Level 1（policy + planner + sequence + voice）逐次运行；Level 2（直接相关 regression + 浏览器 smoke）批次完成后运行一次；
Level 3（`test-all --quick`）在 Phase 2D freeze 时运行**一次**（结果见报告；唯一红项是既存 baseline）。
没有"修一个失败 → 全量 → 再全量"的循环；没有为 baseline 重跑整套。

## 19. Known limitations

1. **没有 UI 触发点**：voice 需要显式意图（程序化接缝）或角色配置 opt-in；UI 留后续（§14）。
2. `IMAGE DEFERRED`（§4）。
3. streaming 仍不支持多段/voice（2C 的既定边界）。
4. 前缀构造让 `metadata.sequenceTotal` 在 materialization path 上缺席（advisory；读取方以消息集合为准）。
5. 真实 TTS 只探到"reference-only"以外的能力：`duration` 需要 Bridge 返回或桥内探针（已复用探针；若都拿不到则 0，气泡按 1″ 显示）。
6. 单回合 voice 上限 3 条（确定性成本护栏）；超出者降级为 text 并记录 `voice-budget-exceeded`。
7. 语音通话（call.js）的语音仍走通话面，不经 chat delivery（未来若接入，需要与逐句播放契约对齐）。

## 19.1 诊断行（观测只有原因，不含内容）

materialization path 失败时打两行 console（沿用仓库既有形态，长度受限、无正文/凭据）：
`[Delivery2D] build failed <message≤120>`（构造抛错）与
`[Delivery2D] build empty <2A 错误词表>`（构造被契约拒绝）。
它们只在**真的失败**时出现，是 §21 要求的 reason 之外的排障入口。

## 19.2 本阶段 `test-all --quick` 的实测口径（freeze 证据）

`static 120 项 · 6 失败`（p22-ui 组全绿）。六条红项与 2A/2B/2C 时期的**同一批既存 baseline** 完全一致
（5 条 BOM 在未触碰的 economy/home-node 文件、counterproof 的 copyClosure fixture、
`test_home_node_client_envelope`、`test_anthropic_wire_contract` 的 git-ignored 暂存副本、
`test_installer` payload 前置、`test_update_card` 依赖 BOM 红）——**2D 没有引入任何新红项**，
也没有为此进入修 baseline 的循环。

## 20. Remaining P23 blockers

从 2A/2B/2C 继承下来、仍未闭合的项（都不阻塞 2D）：
1. `social.js` / `role-dm.js` 的**读取顺序**未接 canonical order（冻结面；已被"id 顺序 == sequenceIndex 顺序"兜住）。
2. 群聊没有回合身份（P24 范畴）。
3. 分页与回合边界的对齐（移动端若需要按回合翻页）。
4. 工具续轮仍立即交付（不经过 timing 队列）。
5. streaming 的多段/voice（需新的 finalized-turn 契约）。

## 21. Future Group Runtime compatibility

* policy **不依赖 friendId**：输入只有 units + 能力/偏好/意图；conversationId 只在 adapter 层出现；
* 因此 `Group Member Turn → Planner → Policy → Sequence → Runtime` 可直接成立，无需重写 2D；
* 本阶段**没有**任何群聊行为：无 groupTurnId、无 Group Brain、无自动选成员、无插话、无群聊 memory/关系图。

## 22. Closure question

2A（契约）+ 2B（交付）+ 2C（结构）+ 2D（模态）已经构成闭环：
结构 → 模态 → identity → 时间 → canonical messages，且每一层都有唯一实现、单向依赖与专项测试。
voice 复用 Phase 1 单一契约、text 保持默认、image 明确延后 ⇒ **P23 READY FOR CLOSURE**。
