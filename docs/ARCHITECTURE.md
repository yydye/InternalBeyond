# Internal Beyond · 架构文档

> 本文档回答「这个项目是怎么工作的」。历史演进见 [CHANGELOG.md](CHANGELOG.md)，设计理由见 [DECISIONS.md](DECISIONS.md)，踩坑见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。

## 1. 总览

Internal Beyond 是一个**个人本地 AI 陪伴站**。**正式发行形态是 Windows 安装包**（P7）：
用户从 GitHub Releases 下载 `InternalBeyond-Setup-<版本号>.exe` 安装，从开始菜单 / 桌面快捷方式启动；
快捷方式最终执行 `启动 InternalBeyond.vbs` → [launch-internal-beyond.js](../runtime/launch-internal-beyond.js)，
由它解析内置 Node 运行时并拉起静态页面服务与可选本地服务。**普通用户不需要 Node.js、命令行或直接打开 HTML。**

页面入口是 [InternalBeyond.html](../InternalBeyond.html)，配套两个本地 Node 服务（开发期用 `.cmd` 脚本单独启动）：

| 组件 | 端口 | 入口 | 职责 |
|---|---|---|---|
| 主站（浏览器） | `127.0.0.1:23120`（安装版由启动链提供） | 快捷方式 → `启动 InternalBeyond.vbs` → `launch-internal-beyond.js` → [internal-beyond-server.js](../services/internal-beyond-server.js)；开发期也可直接打开 `InternalBeyond.html`（`file://`） | 主聊天（浏览器直连各家 AI API）、社交圈、日记、记忆、工作区、游戏等全部页面功能 |
| Bridge 后端 | `127.0.0.1:23115` | 安装版随启动链自动拉起；开发期 `start-bridge-service.cmd` → [ib-bridge-service.js](../services/ib-bridge-service.js) | 表情包、心语墙、健康/定位/天气看板、酷狗点歌、Bark/ntfy 推送、上下文进度条、`/continue` 续写、AI 常驻会话（多模型）、TTS 语音气泡、多窗口同步 |
| Active companion | `127.0.0.1:23114` | 安装版随启动链自动拉起；开发期 `start-active-service.cmd` / `start-local-services.cmd` → [active-message-service.js](../services/active-message-service.js) | 浏览器关闭后的后台执行：主动消息计划（plans）、朋友圈调度（moments）、AI↔AI 回复链续推、事件回传 |
| 静默重启控制面 | `127.0.0.1:23116` | [local-services-runner.js](../runtime/local-services-runner.js) | 诊断页「尝试修复」调用的真实恢复动作 |

- **无构建步骤**：全部是原生经典脚本，HTML 按固定顺序 `<script>` 加载。
- **内置 Node 运行时**（P1）：安装包自带 `runtime\node\node.exe`（Node 24 LTS 精确 patch，见 `runtime/node/VERSION`），
  解析顺序 `IB_NODE` → `runtime\node\node.exe` → PATH（**PATH 仅开发/兼容兜底**）；内置运行时损坏时报错且不回退。
- Bridge 纯 Node 内置模块零依赖；WebSocket 为手写 RFC6455 实现。
- 主聊天仍由浏览器直连各家 API；Bridge 不做主聊天代理。AI 常驻会话是独立于主聊天的一套。
- **启动状态**：每次启动把真实状态写入 `%LOCALAPPDATA%\InternalBeyond\boot-state.json`（P2），
  诊断页（P5）以它解释"本次启动发生了什么"、再以实时探测给出当前状态。

可用环境变量覆盖服务参数：`IB_BRIDGE_PORT` / `IB_BRIDGE_HOST` / `IB_BRIDGE_DATA_DIR`、`IB_RESIDENT_TICK_MS`（Bridge 定时扫描间隔）、`IB_ACTIVE_DATA_DIR`（companion 数据目录，测试用）、`IB_WEB_PORT` / `IB_RESTART_PORT` / `IB_VISION_PORT`、`IB_SOCIAL_OBSERVE=off`（关闭观测持久化）。

## 2. 目录与模块结构

```
InternalBeyond/  # 仓库根目录（根只放入口 / 许可 / 版本 / 元数据，其余按职责入子目录）
├── InternalBeyond.html          # 入口 HTML（页内仍有少量内联脚本与全部页面 DOM）
├── VERSION                      # 单一发行版本源（安装后同位置）
├── README.md                    # 用户安装 / 使用 / 构建 / 测试说明
├── LICENSE                      # 项目许可（PolyForm Noncommercial 1.0.0）
├── .gitignore .editorconfig     # 版本库与编辑规范（.editorconfig 的 root=true 要求它留在根）
├── 启动 InternalBeyond.vbs      # 用户启动入口实现（安装包快捷方式目标，留在根）
├── services/                    # 本地服务 composition root（发行包保持同一相对结构）
│   ├── ib-bridge-service.js     # Bridge composition root（约 998 行，端口 23115）
│   ├── active-message-service.js# Active companion composition root（约 268 行，23114）
│   └── internal-beyond-server.js# 本地静态页面服务（23120，AudioWorklet 必需）
├── runtime/                     # 启动链 + 内置 Node 运行时
│   ├── launch-internal-beyond.js# 正式静默启动链（快捷方式最终执行）
│   ├── local-services-runner.js # Bridge + Active 统一控制器 + 23116 重启/停止控制面
│   ├── boot-state.js            # 启动状态记录（诊断唯一来源）
│   ├── product-version.js       # VERSION 的唯一 Node 侧解析器 + 唯一 semver compare（U-D4）
│   ├── update-manifest.js       # 更新清单契约（U1）：schema / 唯一 URL 构造 / validate / parseInstallerUrl
│   ├── update-check.js          # 更新检查运行时（U2）：传输 + 回退门 + 缓存 + fail-open
│   └── node/                    # 内置 Node 运行时（node.exe 不入库，由 scripts/update-node-runtime.ps1 下载）
├── bridge/                      # Bridge 工厂模块
│   ├── util.js                  # deepMerge / backupBrokenFile / uid / todayStr / constantTimeTokenMatch / parseQuery
│   ├── config.js                # createConfig({dataDir, writeJson})：config/configRaw/configInvalid/LAN_EXPOSED/鉴权辅助
│   ├── clients.js               # createClients({config, getGeoLatest})：天气(wttr.in)、网易云/酷狗、Bark/ntfy
│   ├── tts.js                   # createTts({config, uid, ttsDir})：Edge 免费 TTS + OpenAI 兼容 TTS
│   ├── persistence.js           # createPersistence({dataDir})：jsonPath/writeJson/saveJson/loadJson/loadList/...
│   ├── ws.js                    # createWs({...})：心跳/recordPush/broadcast/WSConnection
│   └── routes.js                # createRoutes(ctx)：CORS/rateCheck/readBody/diagnostics/handleHttp
├── active/                      # companion 域模块（CommonJS 工厂 + 依赖注入）
│   ├── persistence.js           # 状态加载(主→.tmp→.bak)/原子写(tmp+fsync+备份轮换)/50ms 合并保存队列
│   ├── plan-domain.js           # 调度计算(nextRun/免打扰)、setting 与 AI 计划净化器、指纹/替换/取消
│   ├── model-client.js          # 主动消息 prompt、anthropic/gemini/openai 三适配、重试与相似度校验、Windows 气泡通知
│   ├── scheduler.js             # executeTask/executePlan/evaluatePlan/schedulerTick/startScheduler/shutdown
│   ├── http.js                  # CORS 白名单(含 PNA 注释)、JSON 响应、全部 REST 路由与 server 实例
│   └── moments.js               # 朋友圈后台域：sanitizeMomentSchedule/parseMomentOutput/executeMomentSchedule/
│                                #   reply-chain 域(syncReplyChainThreads/maybeCreateReplyTask/executeReplyChainTask/
│                                #   replyChainCrashRecover/replyChainPrune)
├── assets/css/                  # core.css(基础主题前 383 行) + core/ 12 段(chat-shell/letters/memory/pages/chat/
│                                #   workspace/api-components/blog/about/widgets/archive-active) +
│                                #   calendar.css / bridge.css / moments.css / social.css + 诊断/向导/指南样式
├── assets/js/                   # 前端模块（见 §3）
│   ├── core.js communication.js workspace.js memory.js active-diary.js social.js integrations.js ...
│   ├── communication/{letters,voice,annotations,summary}.js
│   ├── workspace/{files,preview,run}.js
│   ├── memory/{auto-memory,constellations}.js
│   ├── active-diary/{active-plans,diary}.js
│   ├── moments.js social-network.js reply-chain-core.js social-observe.js
│   ├── setup-wizard.js diagnostics.js guide-beginner.js context-snapshot.js error-catalog.js
│   ├── ib-namespace.js local-first.js local-vault.js site-operations.js bridge.js calendar.js preloader.js ...
│   └── game 六文件在 game/ 下（见 §8）
├── assets/images/               # 主题背景：bg-internal.jpg / bg-infernal.jpg / bg-canvas.png（后者 6MB，不入发行包）
├── assets/icons/IB-icon.ico      # 官方图标（快捷方式 / 卸载项 / 通知）
├── apps/                        # APP 目录（catalog.json 运行时 fetch，catalog.js 为 file:// 回退）
├── game/                        # game_module.js / game_tarot.js / game_story.js / game_dialogue.js / game_room.js / game_tea.js
├── installer/                   # Inno Setup 脚本 + 语言文件 + 运行时 pin + tools/ib-stop.js
├── scripts/                     # 构建 / 发行审计 / 载荷清单 / 截图管线 / 进程与运行时脚本
│   ├── scripts_check_html.js    # 提取 HTML 内全部 <script> 块逐个 node --check
│   └── windows/                 # 开发期 Windows 辅助脚本（start-*.cmd / Start Internal Beyond.cmd /
│                                #   create-desktop-shortcut.cmd / test-ui.cmd，均不随包分发）
├── docs/                        # 机制文档（ARCHITECTURE / CHANGELOG / DECISIONS / HANDOVER /
│                                #   TROUBLESHOOTING / INTERNALBEYOND_AI_RULES + 其余机制文档）
│                                #   + guide 截图 + history 归档
├── vision/                      # 可选本地视觉服务（Python，默认不随包分发）
└── tests/                       # 全部测试套件（与统一入口同住，可从任意工作目录运行）
    ├── test-all.js              # 统一测试入口（--quick / --browser / --all）
    ├── test_*.js                # 各冒烟 / 单元 / 集成套件
    ├── test_vision.py           # 可选 Vision 服务测试（需 Python + 本地服务，不进 --all）
    └── middle-brain-calibration{,-cases}.js   # 角色一致性校准框架与用例表
```

测试脚本一律用 `const ROOT = path.resolve(__dirname, '..')` 定位仓库根，
**不依赖 `process.cwd()` 恰好等于仓库根**；`test-all.js` 显式区分
`TEST_ROOT = __dirname` 与 `REPO_ROOT = path.resolve(__dirname, '..')`，
并把子测试的 cwd 固定为 `REPO_ROOT`（与迁移前 `cwd === 仓库根` 的行为一致）。


### HTML 加载顺序（关键约束）

1. `assets/js/ib-namespace.js` **最先**（创建 `window.IB` 与 `IB.section/expose`）；
2. 其余 assets 脚本按原语句顺序加载（core → communication(+communication/*) → workspace(+workspace/*) → memory(+memory/*) → social → moments 相关：`reply-chain-core.js` 在 `moments.js` 之前 → `social-network.js` → active-diary（`active-plans.js` → `diary.js` → `active-diary.js`）→ integrations → bridge → calendar → game 六文件（在 `assets/js/calendar.js` 之后、`room-integration.js` 之前）→ …）；
3. CSS 以原始区段顺序加载：core.css 之后按序加载 `core/` 12 段（顺序断言由结构测试固化），再 moments.css / social.css 等。

前端拆分文件统一为 **UTF-8 BOM**（`.editorconfig` 已配置）；`test_frontend_structure.js` 的 `encoding.bom.*` 断言会拦截丢 BOM 的文件。

## 3. 前端架构

### window.IB 命名空间与双挂载

- `ib-namespace.js` 提供 `window.IB`、`IB.section('chat.letters')` 自动建链、`IB.expose(name, exports)` 幂等合并注册。
- 全部 `assets/js/*.js`（21 个文件）与 `game/*.js`（6 个文件）均已注册到 `window.IB`（如 `IB.chat` / `IB.workspace` / `IB.memory` / `IB.active` / `IB.moments` / `IB.socialnet` / `IB.game` / `IB.ops` / `IB.ext` / `IB.core` / `IB.social` …）。
- **双挂载过渡机制完整保留**：函数/const 直接挂 window；会被重新赋值的 var/let 用 `Object.defineProperty` getter/setter 实时转发 IIFE 局部绑定；被 HTML 内联 `onclick` 调用的函数必须保留 window 挂载。跨文件调用全部经 window 桥。
- 子模块统一 IIFE 包裹：`(function(NS){ ... })(window.IB || (window.IB = {}));`——结构测试 com.*/ws.*/mem.*/active.* 断言首尾标记与独立语法。

### 设计变量体系

全局语义设计变量（surface / content / border / focus / shadow / radius / motion / font / spacing / status），Light 与 `body.theme-infernal` 分别覆写；Bridge 工具箱、Moments、Social Net 复用同一套变量。静态 HTML 内联 style 预算 ≤200 处（运行状态/动态几何值除外），由结构测试把关。

### 关键包装器（依赖全局函数，勿改名）

`window._tkRecord`、`window._assistantResponseParts`、`window.sendChatMessage`、`window.dbPut`、`window.ibMusicPlay`、`window.ibBridgeBase`。

- 上下文进度条：Chat 顶部，70% 橙、85% 红；优先服务端 `/api/context`，离线用 localStorage 估算。
- `/continue`：包装 `_assistantResponseParts`，仅当未达上限（2 次）时剥离标记并自动续写；达到上限保留标记；新用户消息重置计数（包装 `sendChatMessage`）。附件保护：自动续写时保存/清空/还原 `_pendingImages/_pendingFiles` 并重绘预览。
- 多窗口同步：包装 `dbPut`（chatMessages 写入后写 localStorage `ib_chat_sync`），其他标签页 `storage` 事件防抖重载聊天。
- 表情：AI 消息里 `[sticker:名字]` 渲染成图（png→svg 失败回退，防重入）；音乐 `[music:ID|歌名]` 渲染为按钮走 `/api/music/open`。
- TTS：AI 气泡上「🔊 朗读」→ `/api/tts` 生成语音条（播放/暂停/时长，全局互斥 `_ibTtsAudio`）；未配置时浏览器 `speechSynthesis` 兜底（`ibTtsFallback`）。
- 重复初始化保护：`ibBoot` 计数守卫（`window.__ibBootCount`）；包装器有效性标记 `data-ib-wrapped` / `data-ib-wrapped-db`（无头测试用）。
- Bridge 面板（右下角 FAB，位置记忆 `ib_bridge_fab_pos`）：4 页签 = 心语墙（写/删/PATCH 改）/ 生活看板（定位、天气、近 7 天健康、推送测试）/ AI 常驻（模型下拉从 `apiConfigs`+`PROVIDERS` 推导 format、会话管理、让TA主动说、自动朗读、上次会话恢复）/ 状态（服务与数据统计、最近推送、Android/OPPO 提示、数据目录）。
- 无障碍：导航链接补齐 `href`/键盘行为/`aria-current`；Bridge 为 non-modal dialog 语义、焦点回收、页签方向键、`inert`/`aria-hidden`；Skip Link 与 reduced-motion。
- 性能：页面后台时暂停雨效、音频可视化、Bridge 轮询与 Calendar 高频读数；移除重复 Cloudflare beacon。

### Image Router（统一图片策略层 · P12）

**唯一图片请求入口**，位于所有 producer 与现有 executor 之间。它只做「策略 + 资源控制」，
**不复制 provider executor、不新建第二份 provider metadata、不新建第二套 Middle Brain**。

```
Chat(<ws_gen_image>) ─┐
Chat(<ws_edit_image>) ─┤
Moments / AI Moments ─┤
(未来 Blog/Diary/Activity) ─┘
        ↓  IB.imageRouter.routeImageRequest({source,characterId,cfg,operation,prompt,size,…})
   Middle Brain 决策缝：middleBrainImageMode() → fast | auto | precision（用户策略）
        ↓
   Image Scheduler（global=2 / Flare=2 / Sunburst=1 / 每角色=1 / queueLimit=8）
        ↓
   现有 executor `_wsExecImageGen`（assets/js/workspace.js，唯一 provider 请求点，120s 超时）
        ↓
   Provider API → 现有存储/UI（aiMsg.images / ICode 归档 / _ibImageDrain）
```

| 文件 | 角色 |
|---|---|
| `assets/js/image-router-core.js` | UMD dual-load（browser `window.IBImageRouterCore` / `require()`），零 DOM / 零 fetch / 零 db：任务识别 `classifyImageTask`、模型决策 `decideImageRoute`、优先级 `decideImagePriority`、`createImageScheduler`、`createImageRouter`、`IMAGE_ROUTER_DEFAULTS`（**唯一**并发/队列/冷却配置点） |
| `assets/js/image-router.js` | 浏览器接线：注入现有 `_wsExecImageGen`（执行器）、`_imgResolveProvider`（provider 推断）、`IB.middleBrain.middleBrainImageMode`（用户策略）、`apiSettings['image_router']`（资源覆盖）；导出 `IB.imageRouter` |
| `assets/js/middle-brain-config.js` | `imageMode` 配置 + Advanced Settings 的 `Fast ─ Auto ─ Precision` 滑动卡片（复用 `_mbSliderBuild`）；`middleBrainImageMode()` 是 MB 唯一对外决策缝 |
| `assets/js/workspace.js` | `_wsExecImageGen(cfg,prompt,size,opts)` 增可选 `opts.signal`（复用其既有 AbortController）与 `opts.quality`（仅 gpt-image 家族下发）；`_execWsOps` 的 `gen_image` 分支经 Router |
| `assets/js/moments.js` | `_momentsRouteImage` 经 Router；`_momentsMakeImage` 传 source/background（手动发布 P1、AI 自主 P3） |

**模型策略**：双模型策略只治理 gpt-image 家族（配置为空或 `gpt-image*`）。
`Fast` → 强制 `gpt-image-2.5-flare`（永不自动升级）；`Precision` → 强制 `gpt-image-2.5-sunburst`（永不自动降级）；
`Auto` → 结构化任务画像（`operation` / `referenceImages` / `previousImage` / `multiTurnEdits` / `identityPreservation` / `finalProduct` / `requestedQuality`，文本线索仅作补充）
决定 Flare 或 Sunburst。provider 为 gemini/anthropic/deepseek 或用户显式配置了非 gpt-image 模型时 → `provider_managed`，只做并发控制、**不改用户模型**。

**优先级**：P0 用户主动编辑 > P1 用户主动生成 > P2 当前聊天/Activity 内任务 > P3 后台（AI 自主 Moments）。
防饥饿：等待每满 `agingStepMs` 提升 1 级、最多 `agingMaxBoost` 级（后台最高只到 P1，永远不超过 P0）；已派发到 provider 的请求绝不抢占。
**队列溢出**：满 `queueLimit` 时用户请求顶掉最低优先级后台任务，后台请求直接被拒（`IMAGE_QUEUE_OVERFLOW`），绝不无限堆积。
**后台保护**：同角色后台生成 `backgroundCooldownMs` 冷却；后台 Sunburst 排队超过 `downgradeAfterWaitMs` 且 Sunburst 槽位被占、Flare 槽位可用时降级 Flare（显式 Precision 不降级）。
**槽位安全**：success / failure / throw / provider error / abort 一律在同一个 `finish` 收口释放 global+model+character 槽位。
**telemetry**：环形缓冲（`IMAGE_ROUTER_DEFAULTS.telemetryLimit`），字段 `source/characterId/requestedMode/operation/referenceCount/editDepth/selectedModel/priority/queueWaitMs/executionMs/downgraded/routeReason/ok/errorClass`，**不含 API Key / base64 / 请求体**；`localStorage.ibImageRouterDebug=1` 打开 `[ImageRouter] …` 调试行。

### Image Editing Runtime（图片编辑 / 参考图 · P13）

Router 的 `operation:'edit'` / `previousImage` / `referenceImages` / `multiTurnEdits` 信号在 P13 有了**真实生产入口**：

```
用户：「就这张，把头发改长一点，其他地方别动」
        ↓
Chat 模型输出 <ws_edit_image>把她的头发改长一点，其他地方不要动</ws_edit_image>
        ↓
Image Reference Resolver（assets/js/image-edit-core.js + image-edit.js）
   选源：explicit selected > 本轮附带图片 > 最近一张可编辑图片（多轮 A→B→C 取最新）
   校验：MIME / 空数据 / 单张体积 / 数量 / 合计体积（超限先复用 moments 压缩 helper）
        ↓  {operation:'edit', previousImage, referenceImages, multiTurnEdits, …}
IB.imageRouter.routeImageRequest（模型决策 / 并发 / 优先级 / 队列 —— 逐字复用 P12）
        ↓  Auto + previousImage → Sunburst（precision classification 自动生效）
Image Scheduler（global=2 / Sunburst=1 / 每角色=1；用户主动编辑 = P0）
        ↓
现有 executor `_wsExecImageGen` →（内部委托薄的 `_wsExecImageEdit`）
        ↓
Provider：OpenAI 兼容 POST {origin}/v1/images/edits（multipart，image / image[]）
          Gemini generateContent + inlineData
        ↓
image B → aiMsg.images（+ lineage）→ 成为新的「最近一张可编辑图片」
```

| 文件 | 角色 |
|---|---|
| `assets/js/image-edit-core.js` | UMD dual-load，零 DOM / 零 fetch / 零 db：`normalizeImage`（各种来源 → 既有 canonical `{dataUrl,base64,mime,name}`）、`checkBudget`、`pickPreviousImage`（**唯一**选源优先级）、`buildEditRequest`、`lineageFor`、`IMAGE_EDIT_DEFAULTS`（**唯一**参考图限额点） |
| `assets/js/image-edit.js` | 浏览器接线：读 `chatMessages` 历史 / ICode 图片文件、超限时复用 `IB.moments._momentsShrinkDataUrl`、显式选中态（`selectImage` / 预览条 chip / 图片查看器「编辑这张图」按钮）、`apiSettings['image_edit']` 限额覆盖。**不选模型、不管并发、不调 provider** |
| `assets/js/workspace.js` | `_execWsOps` 的 `edit_image` 分支 → `_wsBuildEditIctx`（Resolver）→ Router；`_wsExecImageGen(opts.operation==='edit')` 委托 `_wsExecImageEdit`（薄 wire format，复用 provider 推断/凭证/超时/响应解析/用量）；`_imgEditCapability` 能力判定；`_wsImageLineage` lineage |
| `assets/js/communication.js` | `_WS_OPEN_RE` / `_segmentAiText` 解析 `<ws_edit_image>`；`_WS_STREAM_STARTS`（`<ws_edit_image` 必须排在 `<ws_edit` 之前）；`_viewImageFull(src,image)` 增加「编辑这张图」；`renderAttachPreviews` 渲染选中态 chip；`_execWsOps` 调用点传 `friendId/threadId/senderName/userMessageId` |
| `assets/js/site-operations.js` | `_IMGGEN_INSTR_BLOCK` 说明 `<ws_edit_image>` 用法（模型不必传 base64/URL/messageId） |

**lineage（轻量，不重构图片存储）**：生成图片在既有 `{dataUrl,base64,mime,name}` 上追加可选
`imageId / parentImageId / generationType('generate'|'edit') / editDepth / model`，随 `chatMessages.images` 持久化。
多轮编辑因此天然形成 `A → B → C`：第二步以 B（`editDepth=1`）为 `previousImage`，并作为 `multiTurnEdits` 信号交给 Router 判 precision。

**能力边界（capability guard）**：只有「有据可依」的 provider/model 允许编辑——
OpenAI 兼容 + `gpt-image*` / `dall-e-2` → `/v1/images/edits`（multipart）；Gemini → `generateContent` + `inlineData`；
`anthropic` / `deepseek` / `dall-e-3` / 自定义模型 → `IMAGE_EDIT_UNSUPPORTED`（**0 次 provider 请求**）。
编辑失败绝不偷偷降级成重新生成（"只改头发"语义会变）；端点不存在（HTTP 404/405）同样报 `IMAGE_EDIT_UNSUPPORTED`。
**参考图限额**：`maxReferenceImages=4` / `maxReferenceBytes=4MB` / `maxTotalReferenceBytes=8MB`（可用 `apiSettings['image_edit']` 覆盖）；
错误码区分 `IMAGE_EDIT_NO_SOURCE` / `IMAGE_EDIT_UNSUPPORTED` / `IMAGE_REFERENCE_INVALID` / `IMAGE_REFERENCE_TOO_LARGE` / `IMAGE_REFERENCE_LIMIT` / `IMAGE_EDIT_ABORTED` / `IMAGE_EDIT_TIMEOUT` / `IMAGE_PROVIDER_ERROR`。

### Image Router 配置层（Settings → API → Image Router · P15）

P12/P13 解决了「谁来路由、怎么编辑」，P15 补上**前端配置入口**：用户此前只能点聊天图片上的
「编辑这张图」，却没有地方决定图片请求到底用哪个 API 配置、哪个模型。

```
设置 → API → Image Router
   ├─ Image Generation：API Config + Model + Enabled + 备用通道
   └─ Image Editing  ：API Config + Model + Enabled + 备用通道
            ↓ 保存  apiSettings['image_router'].routes（与既有并发覆盖字段同 key 共存）
   IB.imageRouter.routeImageRequest
            ↓ resolveRoute({operation})  ← image-router-config.js
        route.apiConfigId → 既有 apiConfigs（endpoint / apiKey / provider metadata，**不复制 Secret Store**）
        route.model       → 唯一模型目录 image-models-core.js（能力校验：generation / editing）
            ↓ 决策（route_model 优先于 Fast/Precision 自动策略）
   Image Scheduler → 现有 _wsExecImageGen → Provider
```

| 文件 | 角色 |
|---|---|
| `assets/js/image-models-core.js` | **唯一**图片模型元数据源（UMD，零 DOM/fetch/db）：`id / label / provider / family / tier / capabilities / wire / qualities / sizes`。含 Image 2.5 的真实 id `gpt-image-2.5-flare` / `gpt-image-2.5-sunburst`，以及 `gpt-image-1` / `dall-e-3` / `dall-e-2` / `gemini-2.5-flash-image`；`listImageModels({capability})` 是能力过滤的唯一实现 |
| `assets/js/image-router-config.js` | 路由配置层（零 DOM / 零 fetch）：`getRoutes` / `saveRoutes`（写 `apiSettings['image_router'].routes`，保留并发字段）、`resolveRoute`（route → 执行器 cfg + 模型 + 备用通道 + 明确错误码）、`describe`（Settings UI 只读描述）。provider 推断与编辑能力判定**复用执行器**的 `_imgResolveProvider` / `_imgEditCapability` |
| `assets/js/image-router-settings.js` | Settings UI（只做界面）：两条路由卡片、能力过滤的模型下拉、「+ 新建」复用既有 `addNewApi()`、当前实际路由展示（`Generation → API 配置 / 模型`）、折叠态持久化 `apiSettings['image_router_ui']`、给 API 编辑器的生图模型输入框填充同一份目录的候选（`datalist`） |
| `assets/js/image-router-core.js` | 新增 `route_model` 策略（显式模型最高优先，Fast/Precision 不能改它）、`imageModelProblem`（目录/能力校验）、`resolveRoute` 注入缝、备用通道重试（只对 `IMAGE_FALLBACK_CODES`）、telemetry 增 `apiConfigId/routeName/modelSource/fallbackUsed` |
| `assets/js/workspace.js` | 生图执行器失败返回补上错误码（`IMAGE_PROVIDER_ERROR` / `IMAGE_TIMEOUT` / `IMAGE_ABORTED` / `IMAGE_ROUTER_PROVIDER_UNSUPPORTED`），结果回传 `route` / `fallbackUsed` |

**解析语义（三条）**：
1. `apiConfigId` 留空 → `inherit`：沿用调用方传入的角色 cfg（**与 P12/P13 逐字一致**，老用户无需重新配置）；
2. `apiConfigId` 有值 → `bound`：完全使用该 API 配置的 endpoint / apiKey / provider，与「正在和谁聊天」解耦
   （后台 Moments、Activity 共用同一条路由）；配置被删 → `IMAGE_ROUTER_CONFIG_MISSING`；
3. `model` 留空 → `auto`（交回 Fast/Auto/Precision 双模型策略）；有值 → `route_model`，**显式模型最高优先**，
   Fast/Precision 覆盖不能改它（否则「UI 改了模型但请求体没变」）。

**只拦确定不可用的配置**（其余如实警告放行，避免把可用配置判死）：
- 路由 `enabled=false` → `IMAGE_ROUTER_DISABLED`（0 次请求）；
- 模型不在目录 / 不支持当前操作 → `IMAGE_MODEL_UNKNOWN` / `IMAGE_MODEL_CAPABILITY`（0 次请求）；
- 端点留空但 provider 有官方默认端点（openai/gemini）→ 可用；否则 `IMAGE_ROUTER_NO_ENDPOINT`；
- **API Key 留空**：端点为本机/内网（`localhost` / `127.0.0.1` / 私网段 / `.local`）→ 放行并记 `no_key_local` 警告
  （local-first 与 Bridge 本地服务就是这种形态）；端点在公网 → `IMAGE_ROUTER_NO_KEY`（必然 401，提前拦下并指明去哪修）；
- `anthropic` / `deepseek` → `IMAGE_ROUTER_PROVIDER_UNSUPPORTED` / `IMAGE_EDIT_UNSUPPORTED`。

**备用通道（可选）**：`fallback = {apiConfigId, model}`，只在主通道返回 `IMAGE_PROVIDER_ERROR` /
`IMAGE_EXECUTOR_ERROR` / `IMAGE_EMPTY_RESULT` 时**重试一次**；缺 Key、模型不支持、被取消、超时一律不重试
（否则一次明确的配置问题会变成两次无意义等待）。备用配置缺失/模型不支持 → 如实降级为「没有备用」并记 warning。

**错误文案**：每个 code 都有独立且可执行的中文文案，一律指明「去哪里修」
（例：`IMAGE_ROUTER_NO_KEY` →「图片 API 缺少 API Key。请前往 设置 → API → Image Router（或该角色的 API 设置）补齐」）。

### Middle Brain 配置区折叠（API 页 · P14）

API 页整个 Middle Brain 区块（说明 / 启用 / Endpoint / API Key / Astra Cognitive Control / Model / Reasoning /
Processing / Image Generation / Character Integrity Guard 及后续所有 Advanced Settings）收在一个**可折叠 section**里，
解决配置区过高、视觉占用过大的问题：

- **结构**：`InternalBeyond.html` 的 `#middle-brain-section` 内新增常驻 compact header
  `#mb-collapse-toggle`（`aria-expanded` / `aria-controls="mb-collapse-body"`）+ body wrapper `#mb-collapse-body`；
  **只包一层**，不改内部任何控件、不新建第二套 Middle Brain UI。
- **折叠语义**：只切 `#mb-collapse-body` 上的 `.is-collapsed`，**不销毁 DOM** —— 再展开后 input / slider /
  API Key 值原样保留，不重新初始化 Middle Brain、不重复绑定 listener（`_mbCollapseBound` 幂等守卫）。
- **header 摘要**（`_mbHeaderSummary()`，随任何配置变化刷新）：
  `model · reasoning effort · processing(service tier) · image mode` + `Enabled / Disabled` 徽标。
- **持久化**：`apiSettings` 私有 key **`middle_brain_ui`** = `{ collapsed }`（与 `image_router` / `image_edit` /
  `bgAi` 同一套 IndexedDB 设置存储方式）。**不写进 `middle_brain` 配置契约**，避免 UI 态污染被 astra / policy /
  judge 层读取的 canonical 配置；也不使用 localStorage（config 层禁止）。
- **默认态**：无用户偏好时 —— 配置不完整（首次配置 / `enabled=false` / 缺 endpoint·model·API Key）→ 展开；
  配置完整（已有用户）→ 收起。**不因 `enabled=true` 强制展开**；用户一旦手动切换过，其偏好优先。
- **动效与 a11y**：`.mb-collapse-body` 用 `max-height + opacity + visibility` 过渡（非 `display:none`），
  `prefers-reduced-motion` 由 `core.css` 全局降为 0.01ms；header 是原生 `<button>`（Enter / Space 原生可用），
  焦点环沿用全局 `:focus-visible`。

### Provider 模型时效与 model policy（唯一真源 · P18 / P19）

模型 id 仍然**只**存在于 `PROVIDERS[id].model`（新建配置的默认值）。P18 在同一文件追加两张**只读**表，
P19 把 model 级能力**追加**到同一张 `MODEL_POLICIES`（不新建第二份能力表）：

- **`MODEL_POLICIES`**（key = 官方 model id）：
  - `supportsSamplingParameters`（P18）：`false` = 官方已移除 `temperature` / `top_p` / `top_k`，
    请求必须省略，否则 4xx。
  - `supportsAssistantPrefill`（P19）：`false` = 该 model 不接受「最后一条 assistant 消息作为 seed」
    （Anthropic 自 4.6 起移除 prefill，官方报 400「This model does not support assistant message
    prefill」）；请求改为把 JSON 意图写成 prompt 约束，**绝不追加 seed assistant 消息**。
  - **表里没有的 model id 一律取默认策略（两项都 true = 旧行为）**，与 P18/P19 之前逐位一致
    ——绝不按前缀 / 正则猜。
  - Anthropic dated snapshot（`claude-sonnet-5-20260701`）按官方命名约定去掉尾部 `-YYYYMMDD` 再查表；
    **两项能力共用同一个 `modelPolicy` lookup**，禁止第二套归一化。
- **`MODEL_AUDIT`**（key = provider id，**审计元数据，不参与运行时判定**）：
  `status`（`current` / `deprecation-risk` / `unverified`）、`latest`（官方最新一代，
  允许与默认值不同）、`evidence`（官方取证 URL）、`audited`（取证日期）。
- **读取面**：`modelPolicy(model)`、`modelSupportsSamplingParameters(model)`、
  `modelSupportsAssistantPrefill(model)`、`providerDefaultModel(id)`、`modelAuditEntry(id)`。
- **消费方**：`communication.js` 的 `_modelSupportsSampling(cfg)`（委托目录，目录缺失回落「照发」）
  门控三处 anthropic `temperature` 赋值（`callApi` / 流式 / 非流式）；
  `ib-model-core.js` 的 `buildRequestBody` 在 anthropic 分支做同样的 sampling 门控
  （该分支自 P20 起先经 `normalizeAnthropicMessages` 归一 system/messages，见下节），
  并按 `supportsAssistantPrefill` 决定「追加 seed」还是「注入 JSON 约束」；
  `active/node-model-port.js` 因此自动继承（Node 主动消息链无需第二处判定），
  并把 `prefillApplied` / `prefillSeed` 透传给 consumer，供 `parsePlanJson` 判断能否接受续写形态。
- **边界**：本区块不是 Model Registry——没有模型枚举、没有价格、没有动态发现；
  已有用户配置的 model **永不迁移**（只有 `onProviderChange()` 的目录预填会写 `#api-model`，
  即「新建」与「用户主动切 provider」两条路径）。

#### 结构化输出意图 vs 传输实现（P19）

`jsonMode` 是**业务意图**（「本次请求需要结构化 JSON」）；`jsonPrefill` 只是历史传输技巧的
seed 文本，不再等同于这个意图。实现由 model policy 决定：

```
jsonMode=true
   ↓ IBModelCore.buildRequestBody（anthropic 分支）
   ├── supportsAssistantPrefill=true  → 追加 {role:'assistant', content: seed}（历史行为）
   └── supportsAssistantPrefill=false → 不追加 seed；把「JSON-only」约束追加到最后一条
                                        user 消息（consumer 已自带等价指令时不插第二份）
```

约束只注入一次（重建 / 重试幂等），不进 `system`（不污染角色设定与缓存前缀）。
解析侧 `parsePlanJson(text, opts)` 的契约：完整 JSON → 围栏 → **仅在调用方声明真实
`prefillSeed` 时**才接受续写形态 → 既有「首个 `{` 到末个 `}`」容错；malformed 返回 null。
**普通聊天历史里的 assistant 消息永远不受此策略影响**——只有请求构造器自己追加的 seed 受控。

#### Anthropic wire request normalization（唯一真源 · P20）

**不变量（本轮建立的契约）：**

> Canonical IB messages may contain system messages. Provider adapters are responsible for wire
> normalization. Anthropic wire messages never contain `system` role; system content is represented
> using Anthropic's top-level `system` field.
>
> Browser and Node must use the same Anthropic normalization truth.

IB 内部的 canonical 消息**允许**出现 `{role:'system'}`（大量 consumer 的 prompt 就是
`{ system, messages:[{role:'system',content:system}, {role:'user'}, …] }` 形态）。因此修正方向
**不是**禁止 consumer 产生 system，而是由 provider adapter 在请求边界归一：

```
Browser canonical messages[]        Node canonical {system, messages}
   （system 在数组内）                 （model-client 把 built.system 放进 spec.systemPrompt）
            │                                        │
            ▼                                        ▼
  communication.js  _ibAnthropicWire()      IBModelCore.buildRequestBody()
            └──────────────┬─────────────────────────┘
                           ▼
        IBModelCore.normalizeAnthropicMessages(prompt, spec)     ← 唯一真源（纯函数）
                           ▼
        { system, messages }（messages 只剩 user / assistant）
                           ▼
        Anthropic body { model, system, messages, … }
```

**`normalizeAnthropicMessages(prompt, spec)` 规则**（`assets/js/ib-model-core.js`，Browser / Node 同一实现）：

1. 候选 system 文本顺序 = 顶层 `system`（`{system,messages}` 形态）→ 随后按出现顺序的 `messages` 里的 system；
2. 完全相同（忽略首尾空白）的文本只保留一份 —— consumer 普遍把同一段 system 同时放进两处，
   去重后与 P20 之前的浏览器语义逐位相同（角色设定不会被投喂两遍）；
3. 不同文本用 `'\n\n'` 连接（稳定分隔符，**不** `join('')`；顺序稳定，多条 system 一条不丢）；
4. 都没解析到时回落 `spec.systemPrompt`（与旧数组形态一致）；
5. `messages` 只保留非 system 项，逐条**浅拷贝**，绝不改动入参对象（冻结输入也不报错）；
6. 无法映射的 role（`tool` / `developer` / 自定义）**不静默删除**，保留原样交由 provider 判定，
   并记入返回值的 `unmappedRoles` 供诊断 —— 静默删上下文比 400 更糟。

**system content 类型**：canonical 契约是 **string**；block 数组 / `{text}` 形态只做最小安全兼容
（`_systemText`），**绝不** `String(content)`（否则会变 `[object Object]`）。

**消费方**：

- `ib-model-core.js` 的 anthropic 分支先归一、再把 canonical messages 适配成 Anthropic content blocks
  （`adaptMessageParts`）；`system` 字段始终存在（无 system 时为 `''`）。
- `communication.js` 三处 anthropic body builder（`callApi` / 流式 `_callApiChatStreamOnce` /
  非流式 `_callApiChatOnce`）统一经 `_ibAnthropicWire()` 转调同一个函数；核心未加载时明确报错，
  不静默降级成另一套语义。
- `active/node-model-port.js` 不自己处理 system —— 它只构造 transport（endpoint / headers），
  body 全部由 core 产出，故 Node 主动消息链（Moments / Scheduler / Reply 链 / Proactive）自动继承。

**只共享归一，不共享生命周期**：fetch / AbortController / SSE 解析 / retry UI / toast /
`cache_control` 断点 / 浏览器直连头（`anthropic-dangerous-direct-browser-access`）/
telemetry / Cache Audit 仍各自留在原 runtime，core 保持零 window、零 DOM、零 fetch。

**诊断**：`validateAnthropicRequestBody(body)` 是纯函数、不抛错（报告 `messages-not-array` /
`system-role-in-messages` / `unmapped-role:*` / `missing-model` / `system-not-string`）。
生产路径**不**据此抛错（IB 没有 body 级 fail-fast 契约，不能为一个诊断断言炸掉用户请求），
只用于测试与诊断 seam。

**JSON 意图不受影响**：归一之后 `system` 与 `messages` 的分工不变 —— canonical system → Anthropic
顶层 `system`；P19 的 JSON-only 约束仍然只追加到**最后一条 user 消息**，不进 system、不污染缓存前缀。

**仍独立于本契约的请求构造**（有意保留，不属于「第二份归一」）：

- `ib-bridge-service.js` 的 AI 常驻调用（独立本地服务，用自己的会话历史；它把非 assistant 角色
  一律收敛成 user 并单独传顶层 `system`，本就满足「messages 无 system」不变量）；
- `test_chat_smoke_provider_contract.js` §0 的 Node 预检小工具（仅供 mock server 路由自检，
  不参与浏览器真实 body 的断言）。

### Provider 目录的呈现层（唯一真源 · P17）

`assets/js/provider-directory.js` 同时是 **协议配置真源**（`PROVIDERS`）与 **呈现层真源**
（P17 `PROVIDER_PRESENTATION`），两者同键（key = canonical provider id）、同文件、互不复制：

- **呈现字段**：`order`（展示顺序）、`group`（`domestic` / `international` / `compatible`）、
  `kind`（缺省 `official`；`custom` 显式 `compatible`）、`shortHint`（一句话说明）、
  `showInPicker` / `showInSetup` / `showInOnboarding`（出现在哪里）、`capabilitiesKnown`
  （false = 不声明能力）。**不含** endpoint / model / format / vision / streaming，
  也不重复 display name（一律用 `PROVIDERS[id].name`）。
- **读取面**：`providerPresentation(id)`、`providerList({where})`、`providerPickerList()` /
  `setupProviderList()` / `onboardingProviderList()`、`pickerGroups()`、`providerDisplayName()`、
  `providerHint()`、`providerBeginnerHint()`（由 onboarding `audience` 派生，不复制）、
  `providerCapabilitiesKnown()`、`providerKind()`。
- **缺省语义**：目录里有、呈现表没写的 provider **仍然出现**（`showIn*` 默认 true、`order` 500、
  `group` `other`）——目录才是 canonical 名单；显式 `showIn*=false` 才是隐藏。
- **消费方**：`social.js` 用 `pickerGroups()` 重建 API 编辑器 `<select>`（optgroup 分组、
  `providerDisplayName()` 作文案；`InternalBeyond.html` 只留 1 个兼容模式 fallback）、
  `setup-wizard.js` 用 `setupProviderList()` + `providerHint()` 渲染卡片、`api-onboarding.js`
  用 `onboardingProviderList()` + `providerHint()` 渲染官方卡片。三处**都没有**自己的顺序 / 文案表。
- **`custom` 语义**：Generic / OpenAI-Compatible 兼容模式——`providerKind('custom') === 'compatible'`，
  不进官方列表、没有官方 onboarding 条目、endpoint/model 为空、`capabilitiesKnown=false`；
  底层 `vision/streaming` 旧默认保留（不改变既有用户配置），只在编辑器里如实说明「IB 不声明它的能力」。
- **纯数据守卫**：`test_harness_boundary.js` 的 DOM 检测在「注释 + 字符串字面量内容都挖空」的代码上运行
  （外加 `window['document']` 这类字符串下标形态的单独匹配），因此 URL / 文案里的 `document`、`navigator`
  不再误报，而真实 DOM 访问仍会被抓到。新增 onboarding / 呈现 metadata 时不需要再回避这类单词。

## 4. Bridge 后端（23115）

### 基本参数

- 默认监听 `127.0.0.1:23115`；`config.json` 里 `lan: true` 改为监听 `0.0.0.0` 并打印局域网地址。
- `ib-bridge-service.js` 是纯 composition root（常量 / 业务状态与锁 / 表情 / 工具目录与 executeTool / AI 常驻引擎 / 低频主动消息 / 服务器启动与升级握手）；bridge/ 下 7 个 CommonJS 模块全部私有作用域 + 显式接口，依赖一律经工厂参数注入，无循环依赖。

### WebSocket 协议（与页面 IBNET 客户端兼容）

- 握手：`hello {client, version, token, capabilities}` → `hello_ack {ok, server, tools}`
- `ping/pong`；`tool_catalog_request` → `tool_catalog`
- `tool_call {id, name, args}` → `tool_result {id, ok, text, data, images}`
- 服务端主动 `push {title, text, from}`
- 鉴权失败 close `4401`；Origin 非法（升级时校验）返回 HTTP 403；协议错误 close `1002`
- CORS 白名单：`null`（file://）、localhost、127.0.0.1、::1；其余 Origin 一律不带 ACAO 头

### WS 工具清单（26 个，暴露给 AI）

`echo`、`sticker_list`、`whispers_read/write/delete/update`、`health_read`、`geo_read`、`weather`、`music_search`、`music_url`、`webhook`、`bark_push`、`ntfy_push`、`tts_speak`、`push_send`、`letter_write/list`、`session_get/save`、`context_stats`、`pay_register_checkout`、`submit_payment`、`pay_request_confirm`、`pay_get_config`、`pay_set_config`

### REST 接口（分组）

- 健康/状态：`GET /health`、`GET /status`、`GET /api/tools`、`GET /api/config`（敏感值脱敏 `***`）
- 表情：`GET /stickers`、`GET /stickers/<file>`（路径穿越防护）
- 心语：`GET/POST /api/whispers`、`PATCH/DELETE /api/whispers/:id`
- 健康：`GET/POST /api/health`（metrics 严格校验，非对象安全兼容）
- 地理：`POST /api/geo`、`GET /api/geo/latest`；天气：`GET /api/weather?city=`
- 音乐：`GET /api/music/search|url|open|play`
- 信件：`GET/POST /api/letters`、`DELETE /api/letters/:id`
- 会话：`GET/POST/DELETE /api/sessions/:key`；上下文：`GET/POST /api/context?friend=`
- 推送：`POST /api/push`、`GET /api/push/history`
- TTS：`POST /api/tts`、`GET /tts/<id>.mp3`
- AI 常驻：`GET/POST /api/ai/sessions`、`GET/DELETE /api/ai/sessions/:key`、`POST /api/ai/chat`、`POST /api/ai/proactive`

### AI 常驻引擎

- 会话存 `resident.json`，支持 `openai` / `anthropic` / `gemini` 三种格式（由 `provider.format` 决定）。
- Anthropic：合并相邻同角色消息，且请求副本末条必须为 user（主动消息会留下 assistant 结尾）；Gemini：`{model}` 占位替换、`systemInstruction`、`x-goog-api-key`。
- `POST /api/ai/chat`：回复结尾 `/continue` 自动续写（默认最多 2 次）；失败回滚用 `splice(userIdx)` 精确移除本轮 user 消息。
- 会话级并发锁：同一 key 同时只能有一个生成任务，第二个返回"正在生成中"。
- `POST /api/ai/proactive`：主动消息（剥离 `/continue`、历史截断 120 条），同时 WS push + Bark + ntfy。
- 定时主动：`resident.json` 里会话 `intervalMin` 为分钟数；扫描间隔默认 60s（`IB_RESIDENT_TICK_MS` 可缩短）。

### 音乐行为

- 点歌按钮走 `GET /api/music/open`：酷狗先隐藏 iframe 触发 `kugou://kugou/play.html?hash=...` 唤起客户端/App，再 `window.open('https://www.kugou.com/song/#hash=...')` 网页兜底；网易云打开 `https://music.163.com/#/song?id=...`。
- `GET /api/music/play` 保留内嵌流式代理；酷狗失败且 `music.fallbackNetease !== false` 时按 `name` 参数自动切网易云外链（实测可放 audio/mpeg）。
- 前端 `ibMusicPlay` 在 Bridge 未启动时也直接尝试打开酷狗网页（fail-open）。
- 背景：酷狗直连播放接口对免费歌/会员 Cookie 一律返回"需要付费"（服务端限制），详见 [DECISIONS.md](DECISIONS.md) D3。

### 推送

Bark（iOS）与 ntfy（Android/OPPO）都支持；`recordPush` 同时记录两者状态到 `push_history.json`，`GET /api/push/history` 供前端"状态"页签展示。

### 配置与数据自愈

- 数据目录（Windows）：`%LOCALAPPDATA%\InternalBeyond\bridge\`，包含 `config.json`、`whispers.json`、`health.json`、`geo.json`、`letters.json`、`sessions.json`、`resident.json`、`context.json`、`push_history.json`、`stickers/`、`tts_*.mp3`。
- 启动时深合并默认配置（缺字段自动补齐并写回）；配置损坏 → 备份 `config.json.broken-*` 并重建；其他数据文件损坏 → 备份 `*.json.broken-*` 并降级为空数据。
- 配置只在启动时读取一次，改配置必须重启服务。

## 5. Active companion 服务（23114）

### 组成

`active-message-service.js`（root，约 268 行）装配五个域工厂 + `active/moments.js`；全部状态读写经 `getState()`（计划域、模型客户端、调度器、HTTP 四层一致），无循环依赖。文件被 require 时不再自启（`require.main` 守卫），`start-active-service.cmd` 直接运行方式不受影响；`module.exports` 供测试直调域函数。

### 状态与持久化

- state 文件版本 3：`plans`、`tasks`、`events`、`armedUsers`（进程本地）、`moments:{}`、`replyChains:{}`；原子写（tmp + fsync + 备份轮换）+ 50ms 合并保存队列；加载时主文件 → .tmp → .bak 依次恢复。
- 吊销/恢复 = armedUsers（重启后需浏览器 reconcile）。

### AI 自主规划主动消息（plans）

**数据流**：`sendChatMessage` 回复保存后 → `_activeMaybePlanNext()`（异步 600ms，fail-open）→ `planNextProactiveMessage()`（`callApiChat` jsonMode + 白名单校验）→ `_activeSaveAiPlan()`（同角色旧 AI 计划替换；绝不替换 `user_reminder`/手动计划）→ IndexedDB `active_message_plans` → 前端 `_activeTick` 30s 调度 + companion 15s 调度（互斥）。

**状态机**：`scheduled → evaluating(原子抢占) → sending → waiting_for_user`（用户回复后取消）/ `cancelled` / `expired`（迟到 >30min 不轰炸）/ `failed`（达 maxAttempts）；`evaluating/sending` 停留 >10min 崩溃回收。

**防重复（四层）**：① IndexedDB 事务原子抢占（`executedLock` 拒绝已执行计划回退，`executedAt` 单调合并）；② 浏览器/companion 互斥（companion 在线且已同步 → 浏览器跳过；浏览器判定离线 → DELETE 副本 + force PUT 抢占，收到 `stalePlan` → 本地标记 waiting 放弃）；③ 生成后复查状态；④ 消息 ID 秒级幂等。

**限制参数**：默认 `MAX_CONSECUTIVE=1`（用户未回复只发一条）；最短间隔 5min 下限/最长 7 天上限（偏好可放宽区间，绝对边界不变）；免打扰 23:00–08:00（可配）；`allowFollowUpPlan` 默认 false（字段已存储供未来扩展）。

**jsonMode 适配**：OpenAI 系 `response_format:{type:'json_object'}`（不支持的中转自动降级重试）、Gemini `responseMimeType`、Anthropic assistant 预填 `{"action":`；所有 provider 均有"严格 JSON 文本 + 容错解析"兜底。普通聊天/流式/DeepSeek think/GLM 隐藏链路零改动。

**companion 新端点**：`GET/PUT/DELETE /plans/:id`（PUT 带 stale/executedLock 服务端权威判定，DELETE 返回 `executed` 标记）；`/reconcile` 只清理调用方声明集合（`task_ids`/`plan_ids`/`moment_ids` 未声明的集合不动，防误删手动任务）。

### Moments 后台调度

- `PUT/GET/DELETE /moments/:characterId`（快照语义：角色偏好 + recent_moments + recent_threads + prefs；PUT 有 user_id 归属 + stale(updatedAt) + executedAt 单调锁）；`/reconcile` 支持 `moment_ids`；`/health` 携带 `moments` 计数（能力探测）与 `reply_chains` 计数。
- 后台只产**纯文字**动态（图片生成依赖浏览器 imageGen 链路）；`schedulerTick` 内可选 `ctx.momentsTick` 钩子（失败被 try 隔离，绝不让 plans/tasks 停止）。
- 浏览器侧互斥：companion 在线且 `/health` 有 moments 能力 → 后台独占（浏览器 tick 不本地生成，仅节流同步快照 ≤60s 一次）；旧版/离线 → 浏览器本地执行（`claimUntil` 3min 认领锁防双标签）。

## 6. AI 社交系统（Moments / Social Net）

### 数据模型（IndexedDB store `moments`，DB_VER 23）

Moment 字段：`id/roleId/authorType('user'|'role')/authorId/content/images[]/visibility(all|user|roles|private)/visibleRoleIds/likes[](string[])/comments[]/source(manual|proactive)/createdAt(ISO)/repostOf/repostText`；Comment：`id/authorType(user|role)/authorId/content/replyTo?/createdAt`。

- **读取侧兼容层**：无 `authorType` 的历史记录按 role 作者解释（`_momentIsUserAuthor` / `_momentsAuthorRoleId`）；`repostOf/repostText/replyTo` 缺省回落渲染。未升 DB_VER，导出/导入结构不变。
- 可见性（作者感知）：`all` 所有可见；`user` 仅用户；`roles` 指定角色；`private` 仅作者自己。用户 private/user 动态对 AI 不可见（除非 roles 列举）；private+role 渲染锁占位卡，private+user 正常卡片。

### 服务层与生成管线

- 服务函数：`createMoment/getMoments/getRoleMoments/getMoment/deleteMoment/likeMoment/addMomentComment/deleteMomentComment`；AI 管线 `generateRoleMoment/generateRoleComment/generateRoleReply`；Prompt Builder `buildMomentPrompt/buildMomentCommentPrompt/buildMomentReplyPrompt`（浏览器与 `active/moments.js` 双端镜像）；聊天注入 `getMomentsContext`（上限 900 字符 = 4 own + 3 others，`_threadMemOk` 门槛）。
- 生成预算：`MOMENT_GEN_MAX_TOKENS=2000`；诊断 stage==='empty-output' 时自适应重试预算加倍（上限 8000）。诊断工具 `_momentsDiagnoseOutput(raw)` 输出 `{outType,len,hasFence,hasBrace,stage,preview}`，stage ∈ empty-output / no-json-object / json-parse-failed / schema-publish-not-boolean / schema-empty-content（解读见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)）。

### 护栏与调度

- 发布频率低/中/高 = 8–16h / 3–6h / 1–2.5h 随机区间；最短发布间隔 45min（`lastPostAt` 会先于去重拦截）；模型返回 `publish:true/false` 不强制发布；失败 console.warn + 60min 退避。
- **动机层（motive，双端镜像）**：JSON 输出增加 `motive ∈ share/daily_life/emotion/reflection/interaction/curiosity/social_response/none`；Prompt 以第一人称【此刻→发圈动机→写作要求】三段要求模型先判断「此刻有没有真实动机」（角色设定/Memory/聊天/主动消息/已发动态/朋友动态/当前时间/距上次发文），无动机即 `publish:false + motive:none`（正常输出，不是失败）；`publish:true` 时 motive 缺失/非法/矛盾归一到 `daily_life`——**motive 不是发布资格门**，发布资格仍由调度+间隔+去重+模型决策共同决定。
- **declineStreak（连续未发计数）**：浏览器 `ib_moments_state_v1[roleId]` 与 companion `schedule.declineStreak`，语义 `publish:true→0 / publish:false→+1`；随 PUT 往返同步（`active/http.js` 按 `lastPostAt` 快慢单调合并），发布事件回传归零。只作为 prompt 上下文（「最近连续 N 次你都没有发」），**无任何 N 次后强制发布的逻辑**。
- 评论：每条动态最多 2 条 AI 评论、每角色评论冷却 45min、同动态同作者去重、评论不再触发评论；触发延迟 20–60s fire-and-forget（localStorage 队列 `ib_moments_commentq_v1` 防双标签，>48h 裁剪）。
- 点赞（AI）：仅 visibility=all、每角色 4 赞/小时、15min 冷却、1h 内与作者互动过则跳过、概率 60% 1 赞/25% 2 赞/15% 0 赞；AI 只加不撤、作者自赞拒绝；零 LLM。
- 亲和度：`_momentsPairAffinity(a,b)` = 40–95 稳定哈希（无存储、无新关系系统）；点赞/评论候选按亲和度过滤与点名，自然出现"常互动/偶尔/潜水"分布。
- 内容质量：发布 Prompt 双端规则 3 拒绝空泛模板（无具体人事物支撑直接 publish:false）；publish:false 是正常输出不是失败；允许短句碎片化。

### AI↔AI 回复链（前台 + 后台）

- 共享核心 `assets/js/reply-chain-core.js`（UMD，浏览器 `<script>` 与 Node require 同一文件）：LIMITS / hashStr / pairAffinity / diceSimilarity / lowInfoMatch / chainRound / canSchedule / replyRoomOk / parseReplyOutput / normalizeReplyTarget / isDuplicateComment / chooseNext / pickNextReplyRole / buildReplyPrompt。
- 常量：`MOMENT_REPLY_MAX_ROUNDS=3`（单线程最多 3 轮回复层，首层评论不计）、`MOMENT_REPLY_COMMENT_MAX=12`、每小时/每日频控 4/12、延迟 30–120s 一步、第三方门槛亲和度 55、链 TTL 7d / 状态上限 200、低信息正则过滤。
- 触发：`addMomentComment` 成功落库 → `_momentsMaybeReplyChain(momentId, commentId)`（幂等：同 comment 只消化一次；旧 comment 拒绝；单线程单 pending；上限预检）→ 延迟 → `_momentsRunReplyStage`（重新校验 → `_momentsPickNextStep` 确定性选角：A 作者回评 / B 已参与者继续 / C 高亲和第三方，一次只选一个）→ 新回复落库后自动安排下一步，直至轮数/评论数/频控/冷却耗尽或模型 decline。
- 幂等三层：① lastConsumedCommentId 拒绝重复消化；② 仅"最新一条评论"可推进；③ pending 拦截并发。刷新后状态在 localStorage（`ib_moments_reply_chain_v1` + 评论时间戳日志 `ib_moments_comment_log_v1` >24h 裁剪）。
- 后台归属互斥：浏览器开着且 companion `/health` 有 `reply_chains` → 链由 companion 独占（浏览器不调度，只节流同步）；否则浏览器本地链照旧。线程合并以「comment id 并集」（后台生成的回复在浏览器 ingest 前不会被快照覆盖）；任务只存指针不复制整帖。taskKey=`momentId:commentId:roleId:round`；running >10min 崩溃回收；到期过 60min 标 expired 不补发；单角色失败重试 15min → failed，不阻塞其它线程。
- 轮数定义：线程中带 replyTo 的角色回复条数（Post→A(首层)→B(→A)→C(→B)=2 轮）。45min 冷却使同一角色在快速链中只发言一次 → "多角色轮流接话"效果。

### Social Net 视图层（social-network.js）

- 页面结构：站点栏 + 页签（默认「社交圈」）、双栏 Feed（头像/昵称/@handle/相对时间/图片网格/点赞/评论/转发/删除/评论预览）、好友栏与好友视图（关注存 localStorage `ib_social_follows_v1`，纯本地标记不进导出）、Profile（Banner/叠压头像/签名/简介/Joined/关注/发布框/动态·回复·媒体三页签）、讨论串弹层（replyTo 树 +「A 回复 B」+ 继续回复）、转发/引用弹层、客户端有界搜索、渲染代际防竞态（`_netPtabSeq/_netFeedSeq`）。
- 包装 `loadMomentsPage` 仅在 page-moments 活动页时接管渲染；直调/后台调用时旧渲染器照常工作（旧契约 id 全部保留：mom-role-filter/mom-feed/mom-compose-* 等）。
- API 编辑器新增「社交身份」区：handle/banner/bio/signature/joinedAt 读写 + @账号规范化查重（大小写不敏感、留空回落）；缺省回落：昵称派生 @slug、渐变 Banner、joinedAt 回落 created。

### 有界读取与存储防护（第三阶段加固）

- `_momentsScanDesc(max)`（byCreated 索引倒序游标 + 4s 兜底 + 索引缺失退化 getAll 截断）与 `_momentsQueryByRole`；热路径扫描上限：聊天注入 150、Feed 360（渲染层仍 30 条/页分页 + 加载更多 `{keepPage}`）、调度上下文 24h 窗口、评论去重 120。
- 存储泄漏治理：commentq 裁剪 >48h 旧键；删除死缓存 `_momentsFeedCache`。
- 图片：1024px JPEG q0.85、单条 ≤9 图、dataUrl≥2.5MB 拒收、AI 发图概率门 45%（能力门 `cfg.imageGen`）+ 最近多条全图防连图、手动上传走 `compressImage`。理论 ~数 MB/月，可接受。

## 7. AI Diary 系统（角色生命日志）

- 存储：IndexedDB `diary_entries`（`id/characterId/date/title/content/mood/diaryType(daily|weekly|event|emotion)/importance(0-10)/relatedMemoryIds/trigger/reason/createdAt`），导出/导入/重置已贯通。
- 调度（仅浏览器前端，companion 未扩展）：`_diaryTick` 挂 30s `_activeTick`——每周周记（默认周日 22:00，周水位线防重复）；每日 AI 规划（每角色每天一次 planner，`shouldWrite` + `importance>=6` 才生成，日水位线占位防重复）；特殊事件（首次聊天、久别重逢间隔 >3 天 → 事件日记，hook 在 `sendChatMessage` 单聊，fire-and-forget）。
- 生成管线 `generateDiaryEntry`：`_diaryContext`（复用主动消息上下文加载）→ `buildDiaryPrompt`（第一人称私人日记，JSON 输出）→ `_diaryParseOutput`（JSON 优先，失败按文本格式「标题：/正文：/心情：」兜底）→ 相似度 ≥0.75 自动重生成一次 → 落库 → `_diaryWriteMemory`（importance≥6 且与现有记忆相似度 <0.8 才写 `memories`，`source:'diary'`）。
- UI：导航「Diary」+ `page-diary`（角色筛选/搜索/统计/「让她写一篇日记」/「今天想写些什么？」/规划设置/时间线/删除）；API 编辑表单头像区「📖 日记」按钮直达。
- 生成预算 maxTokens 2000（与 Moments 同级）。

## 8. 游戏模块（game/ 六文件）

按原语句顺序加载于 `calendar.js` 之后、`room-integration.js` 之前：

| 文件 | 职责 |
|---|---|
| `game_module.js`（约 1614 行） | 房间核心：配置 / CSS 注入 / 状态 G / 视口 / 寻路 / 点击与交互分发 |
| `game_tarot.js` | 塔罗（牌组数据 / 牌面 / 牌阵 / 抽牌与解读 UI） |
| `game_story.js` | Story（AI 分支叙事引擎 + 故事视窗演出） |
| `game_dialogue.js` | 对话（分页 / 打字机 / Sui 问答 / 家园导览，`window.startHomeTour` 在此导出） |
| `game_room.js` | 房间尾段（换装 / 渲染循环 / 精灵 / 存档 / 面板与宠物窗 / bootstrap 与 `window.G` 导出） |
| `game_tea.js` | 茶歇（茶点数据 / 选单 / 精灵动画 / 聊天与存档） |

拆分方式：保持原 IIFE 语句顺序，函数/常量声明按域平移为顶层全局声明（各文件开头 `'use strict'` 保持原严格模式语义）；202 个顶层标识符与 assets/js 全部顶层标识符零冲突；三个 CSS 模板插值无 TDZ 风险。已注册 `IB.game` 合并注册（202 名字）。

行为约定：角色开局处于 sleeping，`onInteract` 会吞掉 sleeping/waking 状态的交互点击；对话打字机打完当前页不会自动翻页，需要点击 next 触发 `advanceDialogue`（第一击收尾打字、第二击翻页、末页触发回调）；Sui 交互需要先走到床边。

## 9. 行为观测层（social-observe）

- `assets/js/social-observe.js`（UMD 双端，与 reply-chain-core 同款模式）：环形事件缓冲 + 按日聚合双轨、方向保留互动矩阵（`actor\u0001target`，用户以哨兵 `user` 入阵）、线程统计纯函数（深度/持续/达限/natural·stale 等）、pairAffinity 快照枚举、小时直方图。LIMITS：TTL 14 天 / 原始事件 ≤3000 / 聚合 ≤30 天 / 归因窗口 5min。
- token 捕获：迟安装包装 `window._tkRecord`（communication.js 三 provider 记账必经点），按 cfg.id+时间窗归因到进行中的社交调用，不改任何请求参数；无 usage 时退化为输入字符计数（`estInputCharsNoUsage`）。
- 接入点全部一行式旁路、失败静默：浏览器 moments.js（发帖/评论/回复/点赞各 blocked 细分与成功路径；companion 事件 ingest 统一入账避免双计）；companion 侧只记后台 llm_call/post_declined/reply_declined/lowinfo/dedupe/block(cooldown_or_rate)（成功结果由浏览器 ingest 记）。
- 持久化：`%LOCALAPPDATA%\InternalBeyond\social-observe.json`（tmp+rename 原子写，30s 节流 + exit flush）。
- 查看/导出：Moments 设置区开关（localStorage `ib_social_obs_v1.enabled`）+ 导出 JSON 按钮；控制台 `await _socialObsPrint(14)` / `await _socialObsStats(30)`。

## 10. 数据存储全景

### IndexedDB（DB_VER 23）

stores 包括：聊天消息（经 dbPut）、`apiConfigs`、`memories`、`blogAnnotations`、`active_message_plans`（v17 起）、`diary_entries`（v17 起）、`moments`（v18，keyPath `id`，索引 `byRole(roleId)`/`byCreated(createdAt)`）、`roleLetters`/`roleLetterMemories`（v19/v20）、`activities` / `favorites`（v21 起，见 §11.1）、`understandings` / `threads`（v23 起，认识层与线索层）。导出/导入：`_ibBuildExportData` 含全部 store（顶层 version 9）、`importAll` 按 keyPath 回灌天然去重。`openDB` 带 `onblocked` 监听（提示关闭旧标签页）。

### localStorage 键（部分）

`ib_chat_sync`（多窗口同步）、`ib_bridge_fab_pos`、`ib_social_follows_v1`（关注）、`ib_moments_reply_chain_v1`、`ib_moments_comment_log_v1`、`ib_moments_commentq_v1`（>48h 裁剪）、`ib_social_obs_v1.enabled`。

### 文件系统

`%LOCALAPPDATA%\InternalBeyond\bridge\*`（§4 清单）、companion state 文件（`IB_ACTIVE_DATA_DIR` 可覆盖）、`%LOCALAPPDATA%\InternalBeyond\social-observe.json`。

## 11. 陪伴活动 / 应用商店 / 收藏夹（Companion World）

> 本组目标是让 InternalBeyond 从「聊天 + 朋友圈 + 通话」进一步变成共享同一套角色/记忆/活动状态/持久化的 **AI Companion World**：Chat / Moments / Call / Coread / Cinema / Favorites / Apps 共用同一套角色、记忆与活动基础设施。全部为 UI 与数据层新增，**不改动** Harness 四文件、ModelPort 等既有边界。

### 11.1 IndexedDB（DB_VER 23）

在既有 28 个 store 之上**增量**新增两个 store（keyPath `id`）：

- `activities` — 陪伴活动会话。字段：`id/type('coread'|'cinema')/roleId/resourceId/resourceKey/title/kind/threadId/progress{page,sec,pct,pageText,recap,subs...}/bookmarks[]/recap/config{}`/status('active'|'paused'|'finished')/createdAt/updatedAt/lastActiveAt`。索引 `byRole`/`byType`。
- `favorites` — 跨模块统一收藏层。字段：`id/type('chat'|'blog'|'letter'|'moment'|'activity'|'cal')/roleId/sourceId/title/body/meta{}/createdAt/updatedAt`。引用式存储：**不复制二进制**（语音/图片在渲染时按 `sourceId` 回读原记录，原记录删除则降级为纯文本）。索引 `byRole`/`byType`。

备份：`_ibBuildExportData` 已含 `activities`/`favorites`，顶层 `version` 升为 **9**；`importAll` 按字段存在性守卫回灌。`site-operations.js` reset 清单与 `local-vault.js` 标签已同步。**保持旧备份（version 8 及更早）可导入**——importAll 为 lenient 逐 store 回灌、按 keyPath id 去重。

### 11.2 统一「Activity / Companion Session Runtime」（`assets/js/activity/activity-runtime.js` → `window.IB.activity`）

Coread 与 Cinema 不各自为政，统一跑在这套运行时上，天然可扩展其它陪伴活动：

- **会话生命周期**：`createActivity`（自动创建/复用一条 `chatThreads` 频道：`kind + resourceKey` 去重，`quiet:true, memory:true`）、`findActivity`、`listActivities`、`saveActivity`、`deleteActivity`、`setProgress`。
- **上下文注入**：`getActivityContext(friendId,{threadId})` 由 `communication.js` 的 `_buildSingleChatContext` 注入（与 `getMomentsContext` 同款钩子）。只透露**到当前页/播放点为止**的内容 + 进度 + 梗概，并附反幻觉边界——即 Mobile 的 `tail()` + `bound()` 语义。`buildActivityContext` 为类型定制（coread=页文本、cinema=最近字幕+进度+帧）。
- **Memory 回写**：`writeMemory` 走 `quickCreateMemory`（`rawSource=coread|cinema`、`domain='陪伴'`、`createdBy=roleId`），写进共享 `memories` 库，能被后续注入。
- **Proactive 联动**：`nudge` 经 `_activeSaveAiPlan` 生成一条**活动感知的主动消息计划** `{source:'ai_planned', intent:'共读/观影…'}`，由既有主动计划机器在设定时刻投递。
- **事件订阅**：`on/off/emit`，供 App 前端订阅 `activity/update`。
- **收藏联动**：`fav` 经 `IB.favorites.add` 把活动收进收藏层。
- 消息页锚：activity 的消息落进频道时带 `threadId`；频道 conversation 即「共读 · 书名」「观影室 · 片名」，与主对话隔离。

### 11.3 Coread（共读间，builtin）

- `assets/js/activity/coread.js` → `window.IB.coread` + `page-coread`。
- 从 Blog（`posts` store）**现读**，不复制书。按段落边界分页（每个读者按 `_charsPerPage`），章节/页码/进度随 `setProgress` 即时写入 `activities.progress`，`getActivityContext` 据此只给 AI 当前页 + 前文梗概。
- 选一位 AI（apiConfigs 非群聊成员），聊天落在 `共读 · 书名` 频道；书签（`bookmarks[]`）、「生成记忆」（writeMemory）、「提醒 TA」（nudge）、「在聊天里打开」（openChat → `page-chat` 选中该频道）。
- 进入：Blog 侧「共读」入口、App Store（builtin）与导航「Apps」→ 打开。

### 11.4 Cinema（观影室，manifest + loader 外部 APP）

- `apps/catalog.json` + `apps/catalog.js`（file:// 退回壳）、`apps/ib-app-cinema.js`（独立 APP）、`assets/js/app-store.js`（loader）。
- APP 经 `IBApps.register({id,version,sdk:2,icon,mount(body,ctx),back,unmount})` 注册，`open(id)` 调 `mount`；APP 只经 `ctx` 与主程序对话（`app/storage/blog/chat/ai/ui/sys/on/off`），**不触碰底层 db/发送函数**——隔离按接口收窄（同 Mobile 约定，非强制 iframe 沙箱）。
- **Media Adapter v1**（`apps/ib-media-adapter.js` → `window.IBMedia`）：统一 `resolveMedia(url|{file}) → {type,provider,id,url,caps{canFrame,canSeek,remote}}` 与 `createAdapter(media,host) → {load,play,pause,seek,getCurrentTime,getDuration,on,destroy}`。支持 `NativeVideoAdapter`（本地/直链 .mp4/.webm/blob:）、`HLSAdapter`（.m3u8，优先浏览器原生 / `window.Hls`，否则 graceful fallback）、`YouTubeAdapter`（官方 iframe API）、`BilibiliAdapter`（官方 embed iframe）、`UnknownAdapter`（未知来源提示，不强行播放）。平台受限（地区/X-Frame-Options/登录/浏览器）只识别并 graceful fallback，**禁止** DRM 绕过 / 防盗链破解 / Cookie·Token 偷取 / 下载受保护视频 / 代理绕过。Cinema Runtime 只依赖统一接口做进度/字幕/弹幕/共看/Memory/Proactive，不复制 Chat/Memory/Activity Runtime。
- 视频/字幕文件**不入库、不随备份**（`ctx.storage` 只存片名/秒数/梗概；播放点不续播）。会话/进度/Memory/Proactive 仍经 `IB.activity` 统一运行时。
- 安装/卸载：enable 集合存 localStorage `ib_apps_on_v1`（app id→1）；builtin 不可卸载、「卸载但保留数据」。

### 11.5 App Store（manifest + loader）

- `assets/js/app-store.js` → `window.IB.apps`：`boot()`（fetch `apps/catalog.json` → script 壳回退）→ `register`/`install`/`uninstall`/`open`/`close`/`isInstalled`/`listEnabled`。
- 外部 APP 按需注入 `<script src="apps/<file>">`（同源 `'self'`，本地离线运行）；`defer` + `data-ibapp`，失败标 `_missing`。
- `page-apps` 渲染 `#appstore-grid`；builtin 项（coread）「打开」即 `navTo('coread')`，外部项（cinema）「打开」走 overlay shell。

### 11.6 收藏夹（Favorites）

- `assets/js/favorites.js` → `window.IB.favorites`：`add/remove/removeBySource/has/list/count`，`type` 为展示语义（text|voice|image|blog|letter|moment|activity|cal）。
- `page-favorites` 收藏墙：按 `type` 分组、引用式解析（语音/图片按 `sourceId` 回读）、长文折叠、语音回放、图片缩略。
- 统一入口 `IB.favorites.add` 供 Chat / Blog / Letters / Moments / 活动共用；`page-favorites` 只读墙，不孤立声明——所有模块经同一层读写。

### 11.7 前端注册与顺序

- 新脚本全部 **UTF-8 BOM**、IIFE `(function(NS){...})(window.IB||(window.IB={}))`、`window` + `IB` 双挂载；加载顺序：`favorites.js → activity/activity-runtime.js → activity/coread.js → app-store.js`（位于 `local-first.js` 之后，全部在 HTML <script> 末端，运行时调用，无加载期依赖）。
- 新增 `assets/css/activity.css`（**外部样式数 19→20**，`test_frontend_structure.js` 已同步）；内联样式预算保持 200/460 不变（全部新样式走 CSS 类）。
- `navTo` 新增 `page-apps`/`page-favorites`/`page-coread` 分派（`typeof xxx==='function'` 守卫）。

## 12. 测试架构

### 统一入口 test-all.js（零依赖，跨平台）

- `node tests/test-all.js --quick`（static + service，约 17s）、`--browser`（Chrome 集成组，串行）、`--all`（默认）。子进程输出透传、任一失败非零退出、分组耗时汇总。服务测试自带随机端口与临时数据目录。
- 截至 2026-08-26：static 2 / service 7 / browser 13 个入口全绿基线（约 150–165s）。（注：原文各节记录的入口/断言计数随轮次增长存在小幅出入，以各日期条目原文为准，见 CHANGELOG。）

### static 组

> 下表脚本名均位于 `tests/`（`scripts_check_html.js` 除外，它在 `scripts/`）。

- `scripts/scripts_check_html.js`：提取 HTML 内全部本地 `<script>` 块逐个 `node --check`（39 个脚本）。
- `test_frontend_structure.js`：UTF-8/BOM/乱码检查（递归 assets/css、assets/js、game）、资源路径、拆分约束、设计变量、内联样式预算、入口语义、16+1 张样式表总数与 core 12 段精确加载顺序、子模块 IIFE 首尾断言（com./ws./mem./active.，用 includes 而非正则）；P12 追加 Image Router 结构守卫（脚本按序挂载、不自行 fetch / 不内置 provider endpoint、必须复用 `_wsExecImageGen` 与 `_imgResolveProvider`、只经 MB 决策缝、producers 不得直接调用执行器、UI 卡片存在）。
  P15 追加配置层结构守卫（模型目录/路由配置/设置脚本按序挂载、core 与 Settings 不得硬编码模型名、模型必须按 capability 过滤、配置层只写 `apiSettings` 且只按 apiConfigId 引用既有 API 配置、不得读取/渲染 apiKey、必须复用执行器的 provider 与编辑能力判定、显式模型必须进决策且能力不足在发请求前失败、备用通道必须有失败类别白名单、Settings 必须复用 `addNewApi()` 并展示当前实际路由）。
- `test_image_router.js`（P12，纯 Node，86 项）：路由（生成/精修/参考保持/Fast·Precision 覆盖/provider_managed）、并发（global≤2、Flare≤2、Sunburst≤1、同角色互斥且不阻塞他人）、优先级与 aging 防饥饿（后台永不超过 P0、不抢占已派发）、失败/abort 槽位释放、队列溢出与驱逐、重复合并、后台冷却与降级（含定时器到期唤醒与自清理）、auto 升级、telemetry 脱敏。
- `test_image_router_config.js`（P15，纯 Node，48 项）：唯一模型目录（Image 2.5 真实 id / 能力过滤 / wire format / 档位）、路由配置归一与持久化（保存 routes 不丢并发覆盖字段）、解析语义（inherit/bound/disabled/配置缺失/缺 Key/缺 Endpoint/不支持 provider/本地端点免 Key）、模型能力校验、备用通道解析、Core 接线（路由模型进入请求 cfg、配置错误 0 次请求、备用只重试 provider 类失败、telemetry 脱敏）、describe 只读描述、错误文案互不相同且指明去哪修。
- `test_model_catalog_freshness.js`（P18，纯 Node，68 项）：默认模型全表锁定 + 每个真实 provider 都有审计状态、`status=current` 必带官方取证 URL（deepseek 锁定官方模型清单页）、policy 语义（未知 id 照发 / dated snapshot 归一 / 不按 provider 一刀切）、DeepSeek vision exp 不被误判、Claude Sonnet 5 与 4.6 的 request policy（真实 `buildRequestBody`）、`communication.js` 三处 anthropic `temperature` 门控、新建与切 provider 用新 default（抽出 `onProviderChange` 真实行为）、已有配置 / 手改 / legacy / unknown model 不被迁移（保存链数据流断言）、以及子进程跑 `test_provider_presentation` / `test_api_onboarding` 作为无回归门。
- `test_anthropic_prefill_policy.js`（P19，纯 Node，75 项）：`supportsAssistantPrefill` 与 dated snapshot 归一（与 sampling 共用同一 lookup）+ Claude 4.6/5/Opus 4.6+ 全部禁 prefill、legacy/unknown 保留旧行为；`buildRequestBody` 在不支持 prefill 时不追加 seed 而注入**一次** JSON 约束（重建 / 重试幂等、consumer 自带等价指令时不插第二份、非 jsonMode 与普通 Chat 零约束）；`parsePlanJson` 完整 JSON → 围栏 → 受控续写（必须回填真实 seed）→ 既有杂文容错，malformed 必失败；真实 Moments prompt 走真实 `node-model-port`（fake fetch）断言 body 形状与 `prefillApplied`/`prefillSeed` 透传；反回归断言「没有任何实现靠删除 `role:'assistant'` 修 prefill」。
- `test_anthropic_wire_contract.js`（P20，纯 Node，122 项）：canonical message contract（system 允许出现）+ 归一规则（顶层/消息 system 合并去重、多条不丢、顺序与分隔符稳定、类型安全不产出 `[object Object]`、冻结输入零 mutation、非法 role 不静默删除而记入 `unmappedRoles`）；Node builder（`buildRequestBody` + 真实 `node-model-port`）与 **Browser builder（逐字抽取 `communication.js` 的 `callApi` / `_callApiChatOnce` 在沙箱内执行，`window.IBModelCore` 挂同一个模块）** 的 system / roles / content / model / max_tokens / temperature policy parity；Moments / Scheduler / 回复链真实 prompt 的 body invariant；P19 不回归（无 prefill / JSON 约束仍在最后 user / assistant 历史逐条保留）；openai / gemini / Responses body 逐位不变；单一真源守卫（全仓只有一份 `normalizeAnthropicMessages`）+ 范围纪律（无 transport profile / 无 DeepSeek `/anthropic` / 无 BMP·SVG 归一）。
- `test_provider_presentation.js`（P17，纯 Node，104 项）：presentation 读取面与顺序 / 分组、两个消费方不存在第二份 order·hint 表、HTML 只剩 1 个 fallback、`social.js` 下拉构建（抽出真实函数 + 最小 DOM shim：选项顺序/分组/文案、默认值、编辑恢复、未知 legacy provider 补占位、目录缺失保留 fallback）、临时目录副本验证「新增 provider 自动出现 / `showIn*` 隐藏 / 无呈现条目也出现」、`custom` 兼容模式语义、目录不含重复 endpoint·format·model、以及 boundary guard 的正负例（真实子进程）。
- `test_harness_boundary.js`（P17 扩充）：DOM 检测在「注释 + 字符串字面量挖空」后的代码上运行，并单列 `window['document']` 形态；自带 6 个负例（URL / 文案含 document·navigator 不报错）与 8 个正例（真实 DOM 访问仍报错）。

- `test_update_manifest.js`（U1，纯 Node，38 项，不联网）：更新清单契约——schema/键序、`build()` 的诚实性（`releasedAt`/`notes` 缺失即省略、绝不编造时间戳）、`validate()` 接受/拒绝矩阵（含 URL 与版本必须互相钉死、`sizeBytes` 合理区间）、`parseInstallerUrl()`、`writeManifest()` 拒绝落盘、构建端不得自行拼 tag/资产名、无执行面、依赖收敛；U2 追加 **U-D1 Revised 传输路由**（冻结地址未被改动、API 端点与版本头、传输白名单四个主机、`assetApiUrl()` 唯一构造、`selectManifestAsset()` 对 draft/prerelease/资产名的严格接受与拒绝）。
- `test_update_check.js`（U2，纯 Node，50 项，**不联网**）：回退门（`fallbackAllowed() === (outcome === 'network')`，且所有 hard failure **一次都不碰** API 路）、网络错误分类到冻结种类、每个跳转 hop 的白名单校验、唯一 semver 比较（数值而非字典序、非法输入返回 null、浏览器侧无第二实现）、24h 缓存（恰好 24h 才过期/手动 `force` 绕过并刷新/校验失败的缓存只算未命中/**失败绝不缓存**/缓存写在 `{app}` 之外/写不进只是 warning）、fail-open（transport 抛异常、reject、返回垃圾都只得到 `no-information`，绝不抛出）、单飞（并发自动检查共用一次往返，手动检查不并入）、`GET /__update-check` 的**真实服务器**行为（启动时 0 次检查、`?force=1`、异源 403、非 GET/POST 405、永远 200、`summarize()` 投影精确且不转发原始 manifest internals），以及接线（发行白名单、启动链不引用、test-all 登记）。

### service 组

- `test_bridge.js`（82 项断言，零依赖）：健康/CORS/心语 CRUD/上下文/地理/通用会话/AI 常驻(/continue/并发锁/主动消息)/TTS 未配置 503/表情与路径穿越/无效音乐 ID/WS 工具调用/Origin/token/配置自愈/推送历史/Anthropic/Gemini mock 校验/TTS mock 全链路/重启恢复/定时器恢复/数据损坏备份。
- `test_active_http.js`（31 项，真实起服务随机端口）：/plans 端点/stale+executedLock/畸形 URL 不崩/reconcile 互不误删/403/脱敏。
- `test_active_plans.js`（31 项，node --test）：计划校验/状态机/连续限制/崩溃回收/时间戳完整性（注意时钟敏感性，见 TROUBLESHOOTING）。
- `test_moments_companion.js`（16 项）、`test_moments_http.js`（17 项）、`test_socialnet_chain_companion_smoke.js`（17 项，mock 端点）。

### browser 组（CDP，需本机 Chrome/Edge）

`test_image_router_smoke.js`（P12，18 项：真实链路 Chat/Moments → Router → 现有执行器 → mock provider，含 UI 策略切换与真实并发峰值）、`test_image_router_settings_smoke.js`（P15，36 项：Settings UI 真实存在 → 保存 → **刷新页面后配置仍在** → Generation/Editing 两条路由用各自的 API 配置与模型发出真实请求（含 multipart `/images/edits` 的源图字节）→ 改模型后 request body 同步改变 → 缺 Key/配置不存在/路由关闭给出明确错误码且 0 次请求 → 本地端点免 Key 放行 → 备用通道重试一次）、`test_dual_window.js`（6 项，动态 `file://` 路径；断言旧 Bridge FAB 为 0、新导航入口为 1；注意：其同步信号用 localStorage 模拟 dbPut 包装器，未走"IndexedDB 写入→包装器→storage 事件"完整浏览器链路）、`test_ui_regression.js`（Desktop/Mobile × Light/Dark 实时切换、Bridge 交互、JS error=0、外部样式数 17）、`test_game_smoke.js`（56 项含命名空间断言）、`test_chat_smoke.js`（31 项，本地 mock OpenAI 端点）、`test_workspace_smoke.js`（28 项）、`test_memory_smoke.js`（23 项）、`test_active_diary_smoke.js`（19 项）、`test_moments_smoke.js`（23 项）、`test_moments_phase2_smoke.js`（28 项）、`test_moments_phase3_smoke.js`（41 项）、`test_moments_user_smoke.js`（24 项）、`test_socialnet_smoke.js`（42 项）、`test_socialnet_chain_smoke.js`（27 项）。

### 测试基础设施约定

- mock 服务器端口 0 自动分配（`listenFree`）；测试端口 `usedPorts` 去重；Bridge 启动 EADDRINUSE 自动换端口重试。
- CDP 测试通用手法与坑（confirm 阻塞、textContent vs innerText、fire-and-forget 审批 Promise 等）见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md) §测试。

## 13. 更新机制（Zero-Touch Update）

> 发布侧契约（产物、上传顺序、清单字段、构建期闸门、安全边界）见 [RELEASE.md](RELEASE.md)；
> 架构决策见 [DECISIONS.md](DECISIONS.md) U 系列。本节只讲**客户端这一侧的形状**。
>
> 进度：**U1（发布契约）+ U2（检查运行时）已实现**；U3（下载/安装）与 U4（Diagnostics UI）待做。

### 三个真源，各自唯一

| 关注点 | 唯一真源 | 谁可以用 |
|---|---|---|
| 清单 schema / URL 构造 / 校验 / 解析 | `runtime/update-manifest.js` | 构建脚本（构造）、Node 侧（校验）、测试 |
| 版本解析与 **semver 比较** | `runtime/product-version.js`（`parse` / `compare`） | Node 侧任意模块；浏览器**不得**再实现一份 |
| 检查（传输 / 回退 / 缓存 / 判定） | `runtime/update-check.js` | `services/internal-beyond-server.js` 的端点；U3 复用其解析结果 |

浏览器只渲染。U4 的诊断页不实现传输、不实现 manifest 校验、不实现版本比较——它只调
`GET /__update-check` 并把返回的投影画出来（`notes` 必须以 `textContent` 渲染，**永不 innerHTML**）。

### 检查路径

```
浏览器  GET /__update-check[?force=1]        （同源守卫：file:// / loopback 允许，其余 403）
   │
   └─► runtime/update-check.js  check() / checkShared()（单飞：并发自动检查共用一次往返）
          ├─ 缓存（24h，%LOCALAPPDATA%\InternalBeyond\update-check.json；force 绕过；失败不写）
          ├─ primary  https://github.com/.../releases/latest/download/update-stable.json
          └─ 仅当 primary 连完整响应实体都没拿到 ──► fallback  GitHub Releases API
                                                        （draft/prerelease 必须为 false、资产名精确匹配）
```

### 五条不可动摇的性质

1. **不在启动关键路径上**：`launch-internal-beyond.js` 与 `local-services-runner.js` 都不引用
   更新模块；`createWebServer()` **不做任何检查**（有测试守着：启动后 0 次）。启动永远不会
   因为网络而变慢或失败。
2. **fail-open**：`check()` 永不抛出、永不返回"非答案"。每条失败路径都归到
   `no-information`，UI 显示"暂时无法检查更新"，绝不变成错误弹窗。端点永远 HTTP 200
   （失败也在 body 的 `status` 里，不在状态码里）。**更新模块本身是静态服务的"可选依赖"**
   （defensive require）：模块缺失或加载失败时服务器照常启动、端点降级为
   `update-module-unavailable`，绝不让更新功能把整个 App 拖下水。
3. **拿到过响应就不换路**：回退条件压缩成一个可审计等式
   `fallbackAllowed(result) === (result.outcome === 'network')`。404 / 403 / 429 / 非法 JSON /
   schema 不符 / hash 非法 / 身份不一致 / 跳转出白名单 —— 全部是终局，**不重试、不换路**。
   回退本身也只走一次，不做重试循环。
4. **手动优先于缓存，缓存优先于网络**：`?force=1`（用户在 UI 点"检查更新"）绕过 24h 缓存并
   刷新它；反之自动检查先用缓存，避免每次开面板都打 GitHub。
5. **无凭据**：匿名只读，不发送 token/Authorization，不读任何 `*_TOKEN` 环境变量。API 限额
   （60 次/小时/IP）只在 primary 网络失败时消耗。

### 端点对外形状（U4 契约）

`GET /__update-check` 返回 `runtime/update-check.js` 的 `summarize()` 投影，字段固定：

```
{ ok, status, updateAvailable, currentVersion, latestVersion,
  fromCache, transport, checkedAt, error: {kind, message}|null,
  update: {version, releasedAt, minimumVersion, notes, notesUrl, sizeBytes, sha256}|null }
```

`status` ∈ `update-available` / `up-to-date` / `no-information`。**原始 manifest、attempts、
warnings 一律不转发**（有测试断言精确键集），所以 UI 不可能意外依赖内部结构。
