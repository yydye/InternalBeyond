# P23 Phase 2C · Delivery Planner

Phase 2C 的唯一职责：**"模型一次生成的内容 → delivery sequence"**（内容结构）。
它不决定时间、不落库、不渲染、不调模型、不调 TTS。

```
Model Turn → (2C Planner: 结构) → (2A Sequence Contract: canonical messages) → (2B Delivery Runtime: 时间) → chatMessages
```

状态：`PASS`。

---

## 0. 硬边界（本阶段遵守了什么）

未改动：`delivery-runtime.js` 的生命周期逻辑（queue / cancel / typing / persistence timing）、
voice playback、group chat、Group Brain、Memory 架构、provider API format、system prompt。
Planner 不写数据库、不操作 DOM、不调 API、不调 TTS、不控制 timer —— 它是**纯逻辑层**。
依赖方向单向：Planner output → Phase 2B Delivery Runtime（绝不反向）。

## 1. Phase 0 audit

| 面 | 结论（源码证据） |
|---|---|
| AI 回复生成路径 | `communication.js:callApiChat*` → `_assistantResponseParts(raw, thinking)` → 片段化处理（`_applyWithdraw` / `_parseMemOps` / `IBCAL.processReply` / `_parseBlogReadOps`）→ MB finalize → 构造 assistant 行 |
| **A. 内容第一次成为 canonical text** | **非流式**：`var replyText=responsePartsN.content`（`communication.js:2945`）之后经上述标签剥离，最终写进 `aiMsg.content`（`:2987`）。**流式**：同一支文本在流式过程中先上屏，收尾时 `_wsFinalizeBubble` 用完整文本重建气泡，再 `dbPut`。两条路都用**同一个** `replyText` 变量作为权威文本。 |
| stream finalize | `streamRefs.forEach(ref=>_wsFinalizeBubble(ref,replyText,_wsResults))` → `_renderSegments`（渲染层分段：文本 / `<ws_*>` 操作卡 / 下载卡） |
| non-stream completion | `dbPut('chatMessages',aiMsg)` → `appendChatBubble('ai',replyText,...)`（先落库后渲染） |
| **B. 已存在的拆分/解析器** | ① `_parseWsOps` / `_renderSegments` —— **渲染层**分段（不是投递层）；② `window.MessagePresentation` —— **投递层**拆句（v10：结构解析 + utterance 分段 + anti-fragmentation + 节奏）；③ `_mdRenderHtml` —— markdown **渲染**；④ `_parseFileBlocks` / `_buildDownloadCard` —— 文件块。 |
| **C. 可复用** | `MessagePresentation` 的**全部切分算法**（结构 tokenizer / beats / 句读与转折分句 / anti-fragmentation）逐字搬进 planner；`delayBetween` 的节奏公式**留在呈现层**（它属于时间，不属于 planner）。 |
| **D. 绝不能放进 planner** | 时间（delay/typing/sendAt）、队列与状态、cancel、typing DOM、落库/渲染、provider 调用、TTS、LLM 决定怎么拆、内容改写、persona 改写、群聊编排、任何凭据。 |

## 2. Chosen planner architecture

新模块 `assets/js/delivery-planner.js`（纯函数、UMD 双载、零依赖）：

```js
planTurn(text, opts) → {
  mode:'single'|'sequence',
  units:[{kind:'text', content:'…'}],   // ★ 无任何时间字段
  segments:['…'], policy:{…}, stats:{…}
}
segment(text, opts) → string[] | null    // 向后兼容 = 旧 MessagePresentation.split 语义
toSequenceInput(plan) → { units:[{kind,text}] }   // 唯一的形状转换点（→ Phase 2A）
summaryOf(plan) → { mode, unitCount, inputChars, policyVersion, reason }  // 只读、无正文
policyFor(hints) → 生效边界（可测）
```

`MessagePresentation`（communication.js）**变成呈现层**：只保留 `mode` 决策与
`delayBetween` 节奏提示，`split/plan` 一律转调 planner（planner 缺席 ⇒ `split` 返回 null ⇒
安全退回单条消息）。**communication.js 里不再有任何第二份拆句规则**（有测试守卫）。
这是本阶段的关键收敛：过去"怎么拆"与"隔多久发"混在一个模块里，现在结构归 planner、
时间归 runtime、落库与渲染归 adapter。

### 2.1 生产接线（谁在哪一步被调用）

```
replyText（最终文本，已剥离 withdraw/mem/cal/blog 标签、已过 MB finalize）
   ↓  MessagePresentation.plan(replyText,{waifu:true})            ← 呈现层（mode + delay）
   ↓  … → IBPlanner.planTurn（内部：结构 → segments）              ← 结构（本阶段唯一实现）
   ↓  plan.messages = [{text, delay}]                             ← 节奏提示（不含在 planner 里）
   ↓  _ibSequenceMessages(texts, ctx) → IBDeliverySequence.buildMessages   ← 2A：id/回合身份/权威
   ↓  _ibStartDelivery(units) → IBDeliveryRuntime.enqueue          ← 2B：时间 / typing / cancel
   ↓  adapter: dbPut + appendChatBubble + 广播
```

形状映射：planner 的 unit 是 `{kind, content}`（本阶段契约的写法），Phase 2A 的输入 unit 是
`{kind, text}`。**plan → 2A 输入的转换点只有一个**：`toSequenceInput()`（生产路径目前
经"segments → strings → `_ibSequenceMessages`"这一层落地，语义完全等价；2D 若需要直接消费
`plan.units`，改用 `toSequenceInput` 即可，不需要新的转换代码）。

## 3. Split policy（冻结）

### 3.1 结构保护（谁绝不被内部切碎）

| 结构 | 处理 |
|---|---|
| code fence（```/~~~）、inline code（`…`） | **atomic**：整块一条 |
| markdown 链接 / 图片 `[t](u)`、`![a](u)` | **atomic** |
| URL（http/https/www） | **atomic** |
| 成对括号（`()`（）「」『』""''`） | recursive：整块或"开括号贴首条、闭括号贴末条"，绝不孤立 |
| JSON / 列表 / 强调（`【】{}[]`）与 `**…**`/`__…__`/`~~…~~` | **atomic**（P23 2C 新增强调保护：否则每条气泡各自渲染成半截粗体） |
| sticker / emoji token（`[sticker:name]`、`[music:id]`） | **atomic**（token 绝不跨条；单独成 token 时它就是一条，与真实 IM 一致） |
| 功能标签（`<ws_*>` / `<cal_*>` / `<mem_*>` / `<think>` / `<withdraw>` / **`<blog_read>`**） | 整条回复**不做任何切分**（单条消息）；`<blog_read>` 是本阶段补的一个真实漏洞（既有规则漏了它，被拆开会让指令各坏一半） |

### 3.2 边界优先级（自然语言）

空行段落 > 句读（。！？!?）> 逗号 + 转折词（不过/但是/所以/其实/对了/还有…）> 长度控制。
顺承词（然后/接着/随后/终于）**不是**边界，保证"她看了你一会儿，然后轻轻笑了一下。"仍是一条。

### 3.3 长度策略（§6 要求"边界明确、可测"）

| 常量 | 值 | 作用 |
|---|---|---|
| `MIN_UNIT_CHARS` | 4 | 低于它的 unit 并入邻居（prefer 前一条；是首条则并入下一条），避免「你」「好」各成一条。合并若会超过长度上界则**保持原样**并记 `stats.shortKept` |
| `MAX_UNIT_CHARS` | 96 | **硬上界**（= 既有 `HARD_LEN`）。超长段按"最近的标点/空白边界"切，找不到边界才按长度切 |
| `SOFT_TARGET_CHARS` | 44 | "一个自然拍"的参考长度（非硬限制，沿用既有值） |
| `SUB_MIN_CHARS` | 14 | 长句次级切分的最小片段（沿用既有值） |
| `BRACKET_INTACT_CHARS` | 48 | 成对结构整体保留的上限（沿用既有值） |
| `MAX_UNITS` | 60 | 硬上限（与 Phase 2A 一致） |
| `DEFAULT_MAX_SEGMENTS` | 30 | 既有"段数上限"（呈现策略）；与长度上界冲突时**长度优先**，段数在 ① 之下让位，总数不超过 60 |

### 3.4 无损不变量

`join(units)` 与原文**仅差空白归一**（planner 自己算 `stats.lossless` 并在测试中逐个用例断言）。
合并"过短 unit"时沿用既有 `_antiFrag` 的同一套拼接规则（无分隔符直接相接），
因此不会新增一类内容改写。

## 4. Legacy compatibility

* 短回复 / 单句 / 纯 token → `mode:'single'`，**一条消息**（`single-unit fast path`）。
* 功能标签回复 → 不拆（`stats.functionalTags`）。
* 空回复 → 不产出任何 unit。
* 生产启用条件**未改变**：仍然是既有的 waifu 开关（`cfg.waifu===true`）+ 非流式。
  Planner 不会把普通回复变成多气泡。

## 5. Streaming behavior

选择 **A：完整 response 后 planner**（用户指定优先项）。
流式路径**完全不接 planner**：仍按既有方式边流边渲染、收尾重建、落库一条消息。
`plan(reply,{streaming:true})` 仍然返回 `{mode:'stream'}`（逐字兼容）。
**Limitation（如实记录）**：流式回复不会走多段呈现 —— 逐块拆句需要新的流式契约，
属后续阶段（2D/2E），本阶段不做。

## 6. Persona compatibility

`hints.style = 'short' | 'long'` 只移动**长度上界**（64 / 160），
句读与转折边界优先级**一字不改**，内容**一字不改**（有测试：
`HINT.sentenceBoundariesUnchanged` / `HINT.noContentRewrite`）。
默认（无 hint）与 Phase 2C 之前的行为逐字一致。
`hints.preferVoice` 被**接受但本阶段无效**（voice planner 不在 2C），并有测试
`HINT.preferVoice.inert` 证明它不改输出。

## 7. Middle Brain extension point

* MB **本阶段不接**（未接一行）。
* 唯一合法的未来通道就是 `opts.hints`（`style` / 未来的 `preferVoice` 等）；
  planner 只**读**这个对象，绝不反向调用 MB、绝不读 MB 全局（测试守卫）。
* MB 永远不能直接控制消息写入：它最多给出 hint，结构仍由 planner 决定，
  时间仍由 runtime 决定，写入仍由 adapter 决定。

## 8. Modified files

| 文件 | 改动 |
|---|---|
| `assets/js/delivery-planner.js` | **新增**：策略常量 + 结构 tokenizer + utterance 分段 + anti-fragmentation + min/max 长度策略 + hints + planTurn/segment/toSequenceInput/summaryOf |
| `assets/js/communication.js` | `MessagePresentation` 收敛成呈现层（mode + delayBetween），拆句全部转调 planner；删除原有第二份算法（约 −7k 字符）；新增 `deliveryPlan()` / `policy()` 只读入口 |
| `InternalBeyond.html` | 新增一行 script（落在既有豁免脚本区段内） |
| `tests/test_delivery_planner.js` | **新增**（A–U + hints + 接线守卫） |
| `tests/test-all.js` | 登记新测试 |
| `docs/P23-2C-DELIVERY-PLANNER.md` | **新增**（本文件） |

## 9. 测试

`node tests/test_delivery_planner.js` → **224 项全绿**：A–U 全覆盖 + persona hint +
Middle Brain extension point + 唯一实现守卫 + HTML 装载顺序。

浏览器端到端（真实页面 / 真实 Chrome / 真实模型 mock）：

* `test_chat_smoke.js --browser` —— **全部通过**（waifu 4.6 段：多段落库、内容无损、
  顺序、`example1.exactly3`、关闭 waifu 时单条）；
* `test_moments_phase4_smoke.js --browser` —— **`waifu.splitRules` 通过**
  （这是 `_waifuSplit` 的直接消费者，证明委派后语义逐字不变）。

## 10. Security findings

* planner 只做字符串切分：**不保存** API key / token / prompt / 正文到任何持久结构。
* `summaryOf()` 只暴露 `mode / unitCount / inputChars / policyVersion / reason`（无正文），
  与 Phase 2B 的 trace 口径一致（turnId / unit count / state）。
* 凭据形状的正文不在 planner 层拦截（它是纯函数，不接触存储）——
  真正的边界仍是 Phase 2A 的 sequence 契约（`secret-in-unit` ⇒ 整批不产出），
  测试 `Q.secret.rejectedDownstream` 证明了这条下游拦截仍然有效。

## 11. Known limitations

1. **流式不接 planner**（见 §5）：只有非流式 + waifu 开启的回复会走多段呈现。
2. planner 只产出 `text`；voice/image 的**结构**尚未产出（schema 已允许，见 §12）。
3. 段数上限（30）在"长度上界优先"时会略微超出（≤60）；800+ 句的极端输入才会出现
   `stats.overflowForced`（最后一条超长，绝不丢内容）。
4. 合并过短 unit 时沿用既有拼接规则（无分隔符），因此跨该点的空白会被归一 ——
   与既有 `_antiFrag` 同一套语义，整体仍是"仅差空白归一"的无损。
5. markdown 强调保护只覆盖 `**`/`__`/`~~` 这三种成对标记（单 `*`/`_` 过于歧义，不碰）。

## 12. Phase 2D prerequisites

1. 若要 **voice/image unit**：planner 只需在 `units` 里产出对应 kind，
   继续复用 Phase 1 voice 契约与既有 image 资产形态；**不得**新建
   `sequenceVoice` / `sequenceImage` 平行 schema。
2. 若要 **流式多段**：必须在流式契约（chunk → 单元边界）上先取得共识，
   并保证与 `orderMessages` / delivery runtime 的顺序语义一致。
3. 若要 **MB 给 hint**：只能经 `opts.hints`，且必须先证明"hint 不改写内容"的不变量。
4. 若要 **Delivery Policy**（哪些回复允许拆、拆几条）：那是策略层，不得写进 planner；
   planner 只回答"给定这段文本，可以切成什么"。
5. **接线清理（低优先）**：把生产路径从 "segments → strings → `_ibSequenceMessages`"
   改成直接 `Planner.toSequenceInput(plan.units)`，让形状映射在代码上一目了然
   （当前两条路语义等价，且已被浏览器端到端测试覆盖；改与不改都不影响契约）。

## 13. Future Group Runtime compatibility

* planner 与身份无关：它只吃文本，因此群聊成员的每一条发言都可以独立规划；
* 输出是 Phase 2A 的 sequence 输入 + Phase 2B 的 conversationId 隔离，
  因此"群回合 = 多个成员 sequence"可以直接复用，无需改动 planner；
* 本阶段**没有**实现任何群聊行为（未改群聊路径、未加 Group Brain）。
