# AI 朋友圈/聊天：多模态图片注入 + 工具自动续轮 + 视觉认知修复 — 持久知识记录

> 2026-08-28 完成。本文是代码仓库内的持久知识条目；Hindsight 知识库与 DSH 本机记忆中另有同内容条目。
> 适用：任何后续需要在「AI 朋友圈 / 聊天 / ICode / 生图」链路上扩展多模态能力的会话。

## 总原则

1. **文字模型与图片模型彻底解耦**：文字模型只输出 `publish / wantImage / imagePrompt`，真正出图由独立 Image Provider（`cfg.imageGen` + `imageGenModel`）完成；
2. **图片是增强、不是硬依赖**：任何失败（Provider 不可用/报错/超时/格式异常/概率门未过）→ 降级纯文字 Moment，绝不影响发文；无孤立图片（图片只能是 `moment.images` / 消息 parts）；
3. **多模态模型默认放行**：未显式配置时视为支持视觉；`cfg.vision===false` 才拒绝；
4. **模型必须被"权威声明"告知自己能看图**——否则模型会从指令字眼里自我推断"我可能不支持视觉"，自认文本模型（MiMo 案例根因）。

## 关键判定（四处统一）

| 函数/判定 | 逻辑 |
|---|---|
| `_momentsVisionKind(cfg)`（moments.js） | DeepSeek 原生 vision 模型 → `deepseek_native`；DeepSeek 文本 → `deepseek_local`（本地视觉描述）；`cfg.vision===true` → `native`；`cfg.vision===false` → `null`；**未设置 → 默认 `native`** |
| `_ibModelCanSee(cfg)`（communication.js） | 同上（布尔化：local/native 都算可看） |
| `_visionOk` / `_gVisionOk`（通信主/群） | 默认放行（`cfg.vision!==undefined?!!cfg.vision:true`）；DeepSeek 文本仍走本地描述 |
| `IBFC.prepare` 的 vision 参数 | 同默认放行 |
| companion 快照 `character.vision` | `cfg.vision===true || (cfg.vision===undefined && !_usesLocalDeepSeekVision(cfg))`（deepseek 文本后台无本地视觉服务→false） |

## 三层修复（MiMo 案例：模型自述"我是文字的，没有眼睛"）

### ① 认知层 — 权威声明（communication.js）
- `_VISION_DECLARE`（主对话 + 群聊 system 注入，`_ibModelCanSee` 命中时）：
  "当前模型支持视觉多模态：你可以（也应当）直接查看用户发送的图片、工作区中读取的图片（ws_read_image）以及刚刚生成的图片…不要自称'看不见图片'或'没有眼睛'。"
- `_WS_INSTR_BLOCK` / `_IMGGEN_INSTR_BLOCK`（site-operations.js）：删除一切"仅对支持视觉的模型生效 / 不支持时会收到…"的表述——**这正是 MiMo 自我推断"我不支持视觉"的误导源**。

### ② 消息层 — 数组 content 注入（communication.js）
- **根因**：`_tailCtx`/`_gTailCtx` 注入对数组 content（带图消息）执行 `String(content)` → `[object Object]` 乱码，图片 part 被销毁；
- **修复**：`_appendMsgText(msg,text)`——数组 → 只更新 text part（`_image`/`_audio` parts 原样保留）；字符串 → 照旧拼接。替换群聊 `_gTailCtx`（2 处）与主对话 `_tailCtx`（1 处）注入口；`_appendLocalVisionContext` 同步加固。

### ③ 持久层 — 隔轮可查（communication.js 主/群消息组装处）
- **根因**：生图/读图结果进 `_ibImageDrain` 队列，被自动续轮消费一次即消失；用户隔几句再问"看看你刚生成的图"时队列已空、上下文无图；
- **修复**：主对话（friendMsgs 之后）与群聊（gMsgs 之后）从**聊天历史**取最近一条 `assistant` 消息的 `aiMsg.images[0]` 补入本轮 `sentImages`（仅 `_ibModelCanSee`；按 dataUrl 去重；单张 ≤2.4MB）。

## 自动续轮（Agent 回合）

- **背景**：既有架构中所有工具结果（`ws_read`/`ws_edit`/`ws_run`/`ws_tool`/生图/读图）都只在**用户下一条消息**时注入 → "调用工具后对话结束，需要一直说"；
- **`_wsToolContinue(cfg,o)`**（communication.js，非流式续轮）：
  1. 消费 `_getWsReadInjection() + _getWsOpFeedbackInjection() + _getWsRunOutputInjection() + _getIbToolResultInjection() + _getBlogReadInjection()`（消费式，用户下一条不会重复注入）；
  2. 消费 `_ibImageDrain`（仅视觉；DeepSeek 文本转 `_describeImagesLocally` 描述文本）；
  3. 构造 `历史 + assistant(上一条) + user(工具执行结果[+图])` → 再次 `callApiChat`；
  4. 渲染为同角色续接气泡（operation cards + 可删除 + chatMessages 落库 + metadata.toolRound）；
  5. 续轮再生产工具 → 继续（上限 `_WS_TOOL_CONT_MAX=2`）；
- 挂接点：主对话流式、主对话非流式、群聊——三处 `_execWsOps` 之后（条件 `_wsParsed.ops.length || files.length`）；
- **零回退风险**：失败静默，工具结果仍在队列，用户下一条照常注入。

## 图片注入快照与预算

- 浏览器 `_momentsCompanionSnapshot`：每条动态带 **前 3 张**图（`images[]` 数组），全局预算 **12 张**，单张 ≤2.4MB（与 `_momentsDefaults` 一致）；保留 `image`（第 1 张）兼容旧读数；
- companion：`sanitizeReplyThread.images` cap 3；`collectSnapImages`（兼容 `image` 单串 / `images` 数组）；`attachImageParts` 单次 ≤6 张；
- 生图/读图成功 → `_ibImageDrain.push(dataUrl)`（cap 6，站 site-operations.js + ibOpsLive 双挂载）。

## 图片凭证独立（可选）

`imageGenProvider`（openai/gemini，留空跟随文字）· `imageGenEndpoint` · `imageGenApiKey`——全部可选，留空=复用文字凭证；`_wsExecImageGen` 按 fallback 链读取；能力拒绝只依据"最终图片协议域"（`imageGenProvider || provider`）为 anthropic/deepseek 时。

## ICode ws_read_image

- `<ws_read_image path="图片文件"/>`（或 name 属性）；`_WS_OPEN_RE` + `_segmentAiText`（read_image 分支）+ `_execWsOps`（执行）+ 操作卡"已读取图片（下一条消息注入）" + `_WS_STREAM_STARTS` + `_WS_INSTR_BLOCK` 说明；
- 容错：path 轻规范化（剥 `ws_gen_image`/`ws_read_image` 前缀）；当前项目找不到 → 回退默认「ICode」文件夹；错误信息＝"文件不存在（请确认文件名/项目）"。

## MiMo-v2.5 接入要点（官方文档）

- OpenAI 兼容：`base_url https://api.xiaomimimo.com/v1`，model `mimo-v2.5`；图片用 `{"type":"image_url","image_url":{"url":"data:{MIME};base64,$B64"}}`（与我们 `_adaptContentForApi` 输出一致）；
- 响应含 `reasoning_content`（推理模型）——适配器已提取；
- 输出长度参数用 `max_completion_tokens`（`_tokParamGet` 自动切换）；
- 图片 token 计量规则见官方文档（PATCH 16 / merge 2 / min 8192 px）。

## 测试与回归

- `test_moments_phase4_smoke.js`：A–J + `sep.*`（凭证解耦）+ `inject.*`（评论/生成/文本不注入/obs/ICode 读图/生图回传/路径容错）+ `vision.*`（默认放行/显式关闭/DeepSeek 本地）+ `tail.*`（数组注入保留图片）+ `toolround.*`（自动续轮/带图续轮/无反馈不续）+ `snap.*`（快照预算）+ 降级用例；
- `test_moments_companion.js`：vision 注入（请求含 image_url 且 Moment/事件仍纯文本）、多张注入、无 vision 不注入、sanitizeReplyThread cap；
- 注意：概率门 hash（`h31(id)+Σcode %100<45`）要求测试内容 hash 过门（否则不触发）；CDP console 事件送达需 setTimeout 兜底；mock 需要记录 `chatImgParts/chatToolRounds/imageHits/geminiHits/auth`。

## 涉及文件

- `assets/js/moments.js`（_momentsVisionKind / _momentsInjectImages / _momentsAppendNote / snapshot）
- `assets/js/communication.js`（_ibModelCanSee / _VISION_DECLARE / _appendMsgText / _wsToolContinue / 历史图补入）
- `assets/js/workspace.js`（_wsExecImageGen / read_image 分支 / 生图入队）
- `assets/js/site-operations.js`（_ibImageDrain / 指令块文案）
- `active/model-client.js`（callCharacterModel 支持 _image parts：openai image_url / gemini inlineData / anthropic image block）
- `active/moments.js`（attachImageParts / collectSnapImages / sanitizeReplyThread / 两处注入）
- `test_moments_phase4_smoke.js`、`test_moments_companion.js`
