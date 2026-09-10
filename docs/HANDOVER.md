# Internal Beyond · 交接文档（Agent 第一入口）

> 本文档回答「项目现在是什么情况、我接下来该干什么」。
>
> **必读（按顺序）：**
> 1. [INTERNALBEYOND_AI_RULES.md](INTERNALBEYOND_AI_RULES.md) —— **开发契约**：执行者/权限边界、先理解再执行、尊重现有架构、修改必须有边界、不制造隐性行为、改后验证、最小化修改、不越权。（此后一切开发行为以此为准）
> 2. [CHRONICLE.md](CHRONICLE.md) —— **编年史**：上游 Sui 时代 → fork(yydye) 时代全史 + 近期 P1/P2 工程记录，先说清"这个项目从哪来、最近在做什么"。
> 3. [ARCHITECTURE.md](ARCHITECTURE.md) —— **怎么工作**：目录/模块/端口/WS 协议/命名空间/前端加载顺序/前端约束（双挂载、BOM、IIFE）。
> 4. [HANDOVER.md](HANDOVER.md)（本篇）—— 现状、当前待办、DO/DON'T、常用命令。
>
> **按需深入：**
> - [DECISIONS.md](DECISIONS.md) —— 为什么这么设计，**含"不要随便改"清单**（D1–D18）。
> - [CHANGELOG.md](CHANGELOG.md) —— 以前发生过什么（逐条演进）。
> - [TROUBLESHOOTING.md](TROUBLESHOOTING.md) —— 踩过什么坑（ENOENT T31/D16、MiMo 'a' T40 等）。
> - [P1-ACOUSTIC-REFERENCE.md](P1-ACOUSTIC-REFERENCE.md) —— 声学语气参考：唯一算法核心 `voice.js::_vmToneAnalyze` + `_vmPcmToAudioLike` 适配层 + request-local 注入、绝不持久化。
> - [VIDEO-RUNTIME-P2.md](VIDEO-RUNTIME-P2.md) —— Video Runtime：三层边界（Video/Communication/Call）、帧→LLM 复用既有路由、**本地 Qwen 定位**（"DeepSeek 瞎子"补丁、保留兜底）。P1/P2 都是"把上游 Call 当素材库取用"的示范。
> - [docs/history/](history/README.md) —— **阶段报告归档**：Zero-Setup P0–P7、Runtime Stabilization / Convergence 的原始实施报告与审计记录（只读历史，不代表当前实现）。
>
> **IB 定位 / 机制（想懂"它是什么"再看这组）：**
> - [WHY_IB.md](WHY_IB.md) —— **为什么做这个**：设计哲学 + 传统 AI vs IB 的对比 + 三支柱 + "它不是什么"。
> - [SOCIAL_RUNTIME.md](SOCIAL_RUNTIME.md) —— **社会闭环**：为什么 IB 不是"带朋友圈的聊天机"（Event→感知→情绪→记忆→关系→决策→动作→新事件）。
> - [MEMORY.md](MEMORY.md) —— **记忆系统**：数据模型/评分/召回/情绪权重/遗忘/固化；**非向量库、文本评分召回**。
> - [AUTONOMY.md](AUTONOMY.md) —— **自主性**：Proactive/Moments/回复链/主动语音/去重降级；**自主≠随机**、无长时程规划、无内容级 OOC 防火墙。
> - [OFFLINE.md](OFFLINE.md) —— **离线能力**：有本地模式 ≠ 真降级；基础功能全离线、配套 fail-open、**模型级需手动本机模型（无自动云→本地切换）**。
>
> 文档状态截至 **2026-09-09**（P9 仓库整理后）。

## 1. 一句话定位

个人本地 AI 陪伴站。**用户入口是 Windows 安装包**：从 GitHub Releases 下载 `InternalBeyond-Setup-<版本号>.exe` 安装后，从开始菜单 / 桌面快捷方式启动（快捷方式 → `启动 InternalBeyond.vbs` → [launch-internal-beyond.js](../runtime/launch-internal-beyond.js)，内置 Node 运行时随包分发，普通用户不需要装 Node、不需要命令行）。页面本体是 [InternalBeyond.html](../InternalBeyond.html)（无构建步骤），配套两个本地零依赖 Node 服务——Bridge 后端 [ib-bridge-service.js](../services/ib-bridge-service.js)（23115：工具/看板/推送/AI 常驻/TTS）与 companion [active-message-service.js](../services/active-message-service.js)（23114：后台主动消息计划、朋友圈调度、AI↔AI 回复链续推），安装版由启动链自动拉起，开发期用 `.cmd` 单独启动。**是个人本地应用，不是 SaaS——不引入 RBAC/鉴权/多用户设计**（[DECISIONS.md](DECISIONS.md) D1）。

> **上游出处**：本仓库是 [Sui-IB/InternalBeyond](https://github.com/Sui-IB/InternalBeyond) 的非官方二次开发版（已与原作者沟通）。对外分发时必须保留原作者署名、原项目地址与许可文件，并在显著位置说明修改内容——README 的「关于本仓库 / About this fork」与「许可与版权 · 衍生版本说明」已按此维护，改动 README 时勿删除这两处。

## 2. 当前状态

- **功能面**：主聊天（浏览器直连各家 API）、社交圈（Moments → Social Net：Feed/Profile/好友/讨论串/转发 + AI↔AI 回复链前后台）、AI 日记、记忆系统、工作区、游戏模块、行为观测层。全部模块已拆分完毕并注册 `window.IB` 命名空间。
- **测试基线全绿**：`node tests/test-all.js --all`（static / service / browser 三组，约 150–165s）。改动后跑这个作为最终验收。
- **发行形态（P1–P7 已完成）**：内置 Node 24 LTS 运行时（P1）、降级启动 / boot state（P2）、错误产品化 IBERR（P3）、首启设置向导（P4）、系统诊断与自恢复（P5）、零基础图文教程 + 截图管线（P6）、Windows 安装包（P7，产物 `dist\InternalBeyond-Setup-<版本号>.exe`，**当前 1.0.3**，per-user 免 UAC，白名单载荷）。
- **Zero-Touch Update（U1–U4 已完成，U5 发布中）**：应用内更新已实现——发布侧清单契约（`runtime/update-manifest.js`）、检查运行时（`runtime/update-check.js`：U-D1 Revised 一主一备 + 24h 缓存 + fail-open）、安装运行时（`runtime/update-install.js`：U-D6 载荷回退 + 四道校验 + detached 启动安装器）、诊断页更新卡片（`assets/js/update-card.js`）。**当前在发版本为 1.0.3（U5-5 发布准备）**；已发布的 `v1.0.0` 早于全部 U 系列，**其用户无法自动升级，必须手动安装一次最新版**（版本语义与发布顺序见 [RELEASE.md](RELEASE.md) §8，用户升级说明见 [release-notes/1.0.3.md](release-notes/1.0.3.md)）。
  - **U5-2A 已修**：安装版欢迎页画窗背景缺失（`bg-canvas.jpg` 随包发布，`bg-canvas.png` 仍是仓库源图、不入包）。
  - **v1.0.2 的发布契约增量**：清单第一次写 `minimumVersion = 1.0.1`（1.0.1 刻意省略，理由见 RELEASE.md §8）；`releasedAt` 继续省略（构建时刻不是发布时刻，§4）。
  - **v1.0.3 的契约增量：无。** 本版只改前端一个渲染闸门（`glass-ripple.js` 的 `idleNow()`，commit `cbd798f`）——更新链、清单 schema、上传顺序、`minimumVersion`（仍为 `1.0.1`）全部按 1.0.2 原样沿用。
  - **E2E baseline 是真实已发布资产**：`1.0.1 → 1.0.2` 的 Zero-Touch Update E2E 必须用 GitHub 上已发布的 1.0.1 安装实例，**不得**用本地 `dist/` 重建产物替代。
- **图片链路（P12 已完成）**：全部图片生成入口（Chat `<ws_gen_image>`、Moments / AI 自主 Moments 配图）统一经 `IB.imageRouter`（`assets/js/image-router-core.js` + `assets/js/image-router.js`）→ Image Scheduler → 现有 `_wsExecImageGen`；GPT Image 2.5 Flare/Sunburst 双模型策略由 Middle Brain 的 `Image Generation`（Fast / Auto / Precision）控制，默认 Auto。并发 global=2 / Flare=2 / Sunburst=1 / 每角色=1，队列上限 8，后台有冷却与降级保护，telemetry 可查（`IB.imageRouter.telemetry()`）。
- **图片编辑（P13 已完成）**：`<ws_edit_image>正文=修改要求</ws_edit_image>`（可选 `path="图片文件"`）→ Image Reference Resolver（`assets/js/image-edit-core.js` + `image-edit.js`，选源优先级：用户显式选中 > 本轮附带图片 > 最近一张可编辑图片）→ `IB.imageRouter.routeImageRequest({operation:'edit',…})` → Scheduler → 既有 `_wsExecImageGen`（内部薄的 `_wsExecImageEdit`）→ provider `/v1/images/edits`（OpenAI 兼容 multipart）或 Gemini `inlineData`。多轮编辑靠 `aiMsg.images` 上的 lineage（`imageId/parentImageId/editDepth`）形成 A→B→C；不支持编辑的模型返回 `IMAGE_EDIT_UNSUPPORTED` 且不发任何请求；参考图上限 4 张 / 单张 4MB / 合计 8MB。
- **Image Router 配置层（P15 已完成）**：Settings → API → Image Router 有两条独立路由（Image Generation / Image Editing），各自绑定 **API Config + Model + Enabled + 可选备用通道**。模型下拉的唯一来源是 `assets/js/image-models-core.js`（含 Image 2.5 的真实 id `gpt-image-2.5-flare` / `gpt-image-2.5-sunburst`，按 `image-generation` / `image-editing` 能力过滤）；路由配置存 `apiSettings['image_router'].routes`（与既有并发覆盖字段同 key）。解析语义：`apiConfigId` 留空 = 沿用角色配置（旧行为不变），有值 = 该路由固定用这个 API 配置；`model` 留空 = 交回 Fast/Auto/Precision 双模型策略，有值 = 显式优先（Fast/Precision 不能改它）。配置问题（路由关闭 / 绑定配置不存在 / 模型不支持 / 公网端点缺 Key）在**发请求前**给出明确错误码与「去哪修」的文案，0 次 provider 请求；本地/内网端点允许不填 Key。
- **仓库为 GitHub Public**：`https://github.com/yydye/InternalBeyond`，安装包通过 [Releases](https://github.com/yydye/InternalBeyond/releases) 发布；`dist/` 已 gitignore，发行产物不进入源码历史。
- **git**：基线 `e4074cc`、模块化检查点 `800411d`。
- **服务运行方式**：安装版由快捷方式启动链自动拉起；开发期 `start-bridge-service.cmd`（23115）、`start-active-service.cmd` / `start-local-services.cmd`（23114）。改配置后必须重启服务（配置只在启动时读取一次）。
- **用户配置实况**（2026-08-06 记录，需与用户确认是否更新）：酷狗 Cookie 已填但直连播放被服务端限制（走"打开酷狗"方案）；`tts.enabled=false`（未配真实 Key）；ntfy/bark 未启用；`lan=false`、token 空；旧式 proactive 关闭（AI 规划主动消息已替代）。配置在 `%LOCALAPPDATA%\InternalBeyond\bridge\config.json`（**含敏感值勿打印勿外传**）。

## 3. 当前正在进行的工作（观察期）

**行为观测层已上线（social-observe.js，纯旁路），正在等待 1–2 周真实分布数据回填，用于校准关系系统参数。**

- 待校准参数：relationship score 初值 / 正负增量 / 时间衰减 / 事件记忆阈值 / prompt 注入数量 / 高亲和短冷却阈值。
- ⛔ **禁止提前实现关系状态层**——这是明确的当前约束（[DECISIONS.md](DECISIONS.md) D13）。
- 数据查看：Moments 设置区开关 + 导出 JSON；控制台 `await _socialObsPrint(14)` / `await _socialObsStats(30)`；companion 侧文件 `%LOCALAPPDATA%\InternalBeyond\social-observe.json`。

## 4. 接下来做什么（候选，按建议优先级）

**当前阶段（U5-5 · v1.0.3 发布准备）：** `v1.0.2` 已按 RELEASE.md §2 顺序上线（tag `v1.0.2` → `7e86c5e`，三个资产 digest 与清单交叉核对通过，Stable 通道已生效）。`1.0.1 → 1.0.2` 的更新链本身已跑通（真实安装实例升到 1.0.2、欢迎页背景恢复），但收尾核验时发现**新的真实安装态回归**：欢迎页的动态水纹特效整片不显示，因此 **U5-4 未给最终 PASS**。根因已定位（R0）并修复：`assets/js/glass-ripple.js` 的 `idleNow()` 里有一条「离开欢迎页（`currentPage !== 'home'`）后暂停逐帧水波模拟」的守卫，深链进入内容页（如 `#diagnostics`）而欢迎页仍可见时它会把整帧渲染掐掉；该守卫自 v1.0.0（`6a61c3c`）起就存在，只是被 1.0.2 之前「背景不显示」的问题掩盖。修复提交 `cbd798f` 已 push。本阶段的唯一目标是把该修复作为 **v1.0.3** 发布，并为 `1.0.2 → 1.0.3` Zero-Touch Update E2E 准备正式资产；用户升级说明见 [release-notes/1.0.3.md](release-notes/1.0.3.md)。`E:\IB-E2E-1.0.1\InternalBeyond` 仍是 baseline 安装实例（**不要卸载**）。U5-2B（legacy root-layout cleanup / `[InstallDelete]`）仍是独立后续项，本阶段不做。

1. **观察期结束后的关系系统校准**（§3 的参数定值与实现）——唯一被明确规划的下一阶段。
2. **诚实清单中仍开放的缺口**（均为可选增强，非缺陷）：
   - companion 后台朋友圈仍只产纯文字（后台图文需在 Node 侧镜像 imageGen 请求逻辑）；
   - AI 社交通知类功能未做；moment 内容语义索引未做；
   - 日记调度仅在浏览器前端（companion 后台日记需 plans 同款机制）；日记特殊事件未全覆盖（生日/关系等级变化缺数据源，若未来加字段可补 `_diaryMaybeEvent` trigger 分支）；
   - Feed 扫描上限 360 之外的旧动态 UI 不再展示（可做时间范围查询）；
   - 可选收紧：逐步删除 window 双挂载（每删一个跑全套浏览器回归，[DECISIONS.md](DECISIONS.md) D6）。
3. **老清单遗留**（2026-08-06 审计标记）：#22 主聊天未接入服务端通用会话；输入状态条、MCP 按需加载等。
4. **可引导用户配置**（截至 08-06 未配）：TTS 真实 Key、ntfy topic、lan/token。
5. **P21 · Native Vision Media Normalization**（P19 登记、P20 重编号，未实施）：统一盘点聊天上传 / `ws_read_image` / tool image / visionReference / 群聊等图片入口；DeepSeek native vision 只发送官方支持的 MIME（JPEG/PNG/GIF/WebP，按内容判定）；BMP / SVG 等在 **request-local boundary** 栅格化（优先 PNG，避免不必要的 JPEG 有损转换）；**不修改 canonical storage**。
6. **P22 Candidate · Transport Profiles**（P19 登记、P20 重编号，未实施）：先设计「provider + transport profile」配置契约，再谈多传输——候选包括 DeepSeek OpenAI 兼容端点与 DeepSeek Anthropic 兼容 `/anthropic` 端点、以及未来其他 provider 的多传输形态。**不要**给 API config 裸加一个任意 `format` 字段。（P19 条目 ④ 的 Node 侧 anthropic `messages` system 透传问题**已由 P20 修复**，见 §7 P20 条目；P22 只管「一个 provider 多种传输」的配置契约设计，不要重新打开已收敛的归一。）
7. **Future · Read-only Model Probe**（P19/P20 只登记，未实施）：「我配置的模型还存在吗」的**只读**探测，不自动修改配置、不建 Model Registry / Model Marketplace。
8. **P8 · 干净 Windows / 用户视角验证矩阵**（P7 遗留）：全新机器、无系统 Node、多用户、UAC 交互路径；以及首次公开发行前的 Release 检查（`dist` 产物 + `SHA256SUMS.txt` 上传、README 下载链接可用）。

## 5. 必读关键信息（DO / DON'T）

### DON'T

- ❌ 仓库是 **GitHub Public**（`github.com/yydye/InternalBeyond`），对外可见：**禁止提交密钥 / Token / 本地绝对路径 / 真实用户数据 / `dist/` 发行产物**；提交前必须全量测试绿；不要 force-push（[DECISIONS.md](DECISIONS.md) D18）。
- ❌ **禁止提前实现关系状态层**（观察期未结束）。
- ❌ 不要试图恢复酷狗内嵌流式播放（服务端限制，[DECISIONS.md](DECISIONS.md) D3）。
- ❌ 不给项目加企业级设计（RBAC/token 鉴权/多用户隔离）。
- ❌ 测试清理时**不要动 23115 端口的用户服务**；测试写操作用 `IB_BRIDGE_DATA_DIR`/`IB_ACTIVE_DATA_DIR` 临时目录，勿污染真实数据（[TROUBLESHOOTING.md](TROUBLESHOOTING.md) T8）。
- ❌ 不要删 Edge TTS 的本地 mock 验证方式而不重新验证协议（[TROUBLESHOOTING.md](TROUBLESHOOTING.md) T2）。

### DO

- ✅ 用**中文**交流。主要使用场景是 Android 手机（OPPO 等国产 ROM 需允许后台运行）：推送走 ntfy、健康走 Health Connect/HTTP Shortcuts。
- ✅ 用户对"看起来实现但实际没实现"非常敏感——交付前给代码证据与测试。
- ✅ 改 `InternalBeyond.html` 或 assets 下任一 JS/CSS 后检查/补回 **UTF-8 BOM**（edit 工具会剥掉，结构测试会拦）；新文件必须 BOM + UTF-8。
- ✅ 本地 file:// 验证改动用 **Ctrl+F5** 强刷。
- ✅ 大文件拆分/批量改写前：先建冒烟测试安全网 + 遵守失败原子性流程（先写新文件最后改父文件、留备份/Git blob）（[DECISIONS.md](DECISIONS.md) D16/D17）。
- ✅ 遇到任何报错先查 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)（本项目踩过的坑几乎都有记录）。

## 6. 常用命令速查

```powershell
# 重启 Bridge 服务
$c = Get-NetTCPConnection -LocalPort 23115 -State Listen
foreach($x in $c){ $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $x.OwningProcess); if($p.CommandLine -like '*ib-bridge-service.js*'){ Stop-Process -Id $x.OwningProcess -Force } }
Start-Process cmd.exe -ArgumentList '/c','start-bridge-service.cmd' -WorkingDirectory '<仓库根目录>'
Invoke-RestMethod http://127.0.0.1:23115/health

# companion（23114）同理：找监听进程确认 services/active-message-service.js 后停止，重跑 scripts/windows/start-active-service.cmd
# companion 功能升级后必须重启一次才会启用新后台能力（否则浏览器自动本地回退，不会双发）

# 全量测试验收
node --check services/ib-bridge-service.js   # 快速语法
node scripts/scripts_check_html.js InternalBeyond.html
node tests/test-all.js --all                 # 最终验收（--quick 约 17s）
```

常用路径：

- 配置/数据目录：`$env:LOCALAPPDATA\InternalBeyond\bridge\`
- 观测数据：`$env:LOCALAPPDATA\InternalBeyond\social-observe.json`
- 前端模块：`assets/js/`（加载顺序与命名空间约定见 [ARCHITECTURE.md](ARCHITECTURE.md) §2–3）
- 项目定位记忆：`project/local-app-positioning.md`

## 7. 已知限制与未验证项（诚实清单）

- Anthropic / Gemini / 真实 TTS / Bark / ntfy 只用 mock 或代码验证，未用真实 Key/设备端到端验证；Edge TTS 真实服务端在当前网络返回 403（地区限制，前端有 speechSynthesis 兜底）。
- 浏览器交互类（弹窗、拖拽手感、自动播放策略、定位授权）未人工实测。
- REST 接口无 token 鉴权（设计如此）；开 `lan` 时建议配 token + 防火墙/Tailscale。
- 主聊天由浏览器直连各家 API；Bridge 不做主聊天代理。
- 双执行器极小竞态（companion 误判离线 + DEL/PUT 双网络失败的理论窗口可能双发，消息 ID 秒级幂等兜底）——按定位接受。
- companion 无鉴权 + null-origin 放行（file:// 必需）的 PNA 理论风险——按个人本地应用定位接受。
- 无害噪音：`assets/images/bg-canvas.png` 404（**预期**：6 MB 原图有意不随包发布，仅作仓库源图；同目录压缩副本 `bg-canvas.jpg` 接住探测，欢迎页画窗背景正常）、Cloudflare RUM 在 file:// 下报错。
- 升级遗留（U5-2B 候选，**未修**）：`installer/InternalBeyond.iss` 没有 `[InstallDelete]`，所以 1.0.0（旧布局，背景图在仓库根）→ 后续版本在**同一目录**升级时，旧布局的根级文件（`bg-internal.jpg` / `bg-infernal.jpg` / `bg-canvas.png` / `boot-state.js` / `Start Internal Beyond.cmd` 等）会留在安装目录里。当前不影响功能（新代码只按 `assets/images/` 探测），但会留下死文件；清理方案与 U5-2A 的视觉 payload 修复分开提交。
- Image Router（P12）：`quality` 目前只在 gpt-image 家族下发（dall-e / Gemini 忽略）；双模型策略不接管用户显式配置的非 gpt-image 模型（`provider_managed`，只做并发控制）。
- Image Router 配置层（P15）已知限制：① 角色的「启用图像生成」开关仍然生效——绑定了路由但角色没开生图，仍会被拦在聊天入口（提示可在 API 设置中开启），这是有意的产品语义（角色级开关 ≠ 凭证级配置）；② 路由配置存在 IndexedDB（`apiSettings['image_router']`），保存后经 `IB.imageRouter.reloadConfig()` 让下一次请求重读；③ 显式选定模型时 Fast/Precision 不再能改变它（要交给 Middle Brain 决策就把模型留空=自动）；④ 备用通道只在 provider/执行器类失败时重试一次，配置类失败不重试；⑤ 模型目录是本地静态表，新增/下线模型需改 `image-models-core.js`（不联网拉取）。
- 图片编辑（P13）已知限制：① 编辑端点按与生图端点同源推导（`/v1/images/generations` → `/v1/images/edits`），**中转站/自建代理必须自己实现该端点**，否则返回 `IMAGE_EDIT_UNSUPPORTED`（HTTP 404/405），绝不回退成重新生成；② 能编辑的模型白名单是 `gpt-image*` / `dall-e-2`（OpenAI 兼容）与 Gemini，`dall-e-3`、自定义模型、anthropic/deepseek 一律不支持编辑；③ 多输入参考图用 `image[]` 字段（gpt-image 家族约定），若某代理只接受单张 `image`，会由 provider 报错；④ 没有 mask / 局部重绘 UI，也没有画笔式编辑器（自然语言多轮编辑已完整可用）；⑤ 参考图超限时复用 `IB.moments._momentsShrinkDataUrl`（1536px JPEG）压缩一次，仍超限则如实报 `IMAGE_REFERENCE_TOO_LARGE`；⑥ 显式选中态只在内存中（刷新后回到「最近一张可编辑图片」语义）；⑦ telemetry 只存内存、不持久化，跨标签页各自一份 Scheduler。

- Provider 呈现层（P17）已知限制：① 「IB 有哪些服务、以什么顺序展示、叫什么、给新手看哪句话」现在只有一份真源（`provider-directory.js` 的 `PROVIDER_PRESENTATION`），API 编辑器下拉 / 首次设置向导 / 获取向导都从它取数，**新增 provider 只需改目录**；② 「新建 API 的默认 provider」仍是历史值 `anthropic`（目录里不存在时退到列表第一项），它没有进呈现表——改默认值会改变既有用户手感，本阶段不动；③ 分组（国内 / 国际 / 兼容）只是呈现，不参与任何协议判定；④ `custom` 的底层 `vision/streaming` 旧默认（`true/true`）保留以免破坏既有配置，只在呈现层声明「不声明能力」并在编辑器里如实提示——能否真用图片 / 流式取决于用户填的服务，点「测试连接」验证；⑤ 呈现表字段改动要同步 `test_provider_presentation.js` 的断言（顺序 / 分组 / 文案都逐项锁住）；⑥ MiniMax 的 `docsUrl` 已在 P18 补齐（`https://platform.minimaxi.com/docs/`）。
- 模型目录时效（P18 已完成）：默认模型只存在于 `PROVIDERS[id].model`；P18 改了 3 个（`claude-sonnet-4-6`→`claude-sonnet-5`、`gemini-2.0-flash`→`gemini-3.5-flash`、`grok-4`→`grok-4.3`），其余 11 个保持原值。**已有用户配置的 model 永不迁移**（打开编辑器 / 启动 / 保存都不改写；只有新建 API 与用户主动切 provider 才取新默认值）。已知限制：① `MODEL_AUDIT` 里 `openai` / `doubao` 标 `deprecation-risk`（有官方弃用信号但缺官方 API 表）、`minimax` / `mistral` / `yi` / `baichuan` 标 `unverified`（查不到官方来源，**保持现状不猜**）——`test_model_catalog_freshness.js` 会锁住这张表，改默认值必须同步审计条目；② Anthropic 自 Sonnet 5 / Opus 4.7 起移除采样参数，`MODEL_POLICIES` 只登记已取证的 4 个 id，其它 id 照发 `temperature`（未知 id 不改变行为）；③ `deepseek-v4-flash-vision-exp` **已由官方取证**（`https://api-docs.deepseek.com/zh-cn/`「首次调用 API」页模型清单列出它，官方「图像理解」页说明它支持图片输入）：实验性视觉模型，模型名精确匹配即可调用，`communication.js` 保留、无策略限制，`MODEL_AUDIT.deepseek` 取证 URL 已改指该页；官方视觉约束（后续改视觉链路时照此核对）：图片仅允许出现在 **user** 消息（system / assistant 带图返回 400）、仅视觉模型接受图片（其它模型 400「This model does not support image」）、支持 JPEG/PNG/GIF/WebP（按内容判定，不看扩展名）、单请求最多 600 张、单边最长 8192px（单请求 ≥15 张时降为 4096px）；IB 现有链路把图片一律挂在 user 消息上，与该约束一致；④ Node 主动消息链（`active/moments.js` / `scheduler.js`）给 Anthropic 发送 assistant prefill（`jsonPrefill`）——第三方报告称 4.6+ 会 400，且本地 `parsePlanJson` 只接受含 `{` 的文本，prefill 续写结果天然不含左括号；这是 P18 之前就存在的独立问题，**P19 已修复**（见下条）。

- Anthropic assistant prefill 兼容（P19 已完成）：`MODEL_POLICIES` 增加 `supportsAssistantPrefill`（与 `supportsSamplingParameters` **共用同一个** `modelPolicy` 归一化，含 dated snapshot）；`claude-sonnet-4-6` / `claude-opus-4-6` / `claude-sonnet-5` / `claude-opus-4-7` / `claude-opus-4-8` / `claude-opus-5` 判定为**不接受 prefill**，`claude-sonnet-4-5` 及未登记 model 保持旧 seed 行为。`ib-model-core.js` 的 anthropic 分支改为：支持 → 追加 seed；不支持 → **不追加 seed**，改注入一次 JSON-only 约束（幂等；consumer 已自带等价指令时不再插第二份；不进 `system`）。`parsePlanJson`（Node `active/plan-domain.js` 与浏览器 `active-plans.js` 逐字同源）新契约：完整 JSON → ```json 围栏 → **仅在调用方给出真实 `prefillSeed` 时**才接受续写 → 既有「首个 `{` 到末个 `}`」容错；malformed 返回 null。`node-model-port` 透传 `prefillApplied` / `prefillSeed`，moments / scheduler / reply 链据此决定是否允许续写解析。已知限制：① **普通聊天历史里的 assistant 消息永不受该策略影响**（只有请求构造器自己追加的 seed 受控，`test_anthropic_prefill_policy.js` 反回归锁死「禁止用删除 assistant 来修 prefill」）；② 既有「前后杂文」容错**保留**（`test_active_plans.js` 锁定的产品契约），本轮没有把 parser 收紧成 JSON-only——「malformed 必失败」只覆盖非 JSON / 非法 JSON / 无括号文本；③ `prefillSeed` 必须是 `{` 开头的字符串，其他形状一律拒绝（不拼非法 JSON）；④ **新发现（P19 登记，P20 已修）**：Node 侧 moments 的 prompt 自带一条 system 消息，`node-model-port` 以 `{system, messages}` 形态交给 core，故该 system 消息会留在 anthropic `messages` 里（浏览器侧走数组形态会被 `_prompt` 归一掉）；这与 Anthropic「messages 只接受 user/assistant」的官方契约不符，高置信但**未用真实 Key 验证**，属 transport 收敛范围 —— **P20 已按 transport 收敛处理（见下条 P20）**；⑤ Structured Outputs（官方 `output_config.format` / 既有 `response_format`）本轮只做可行性审计，**未接入**（见 CHANGELOG P19 结论）；⑥ Temperature UI 已按 policy 禁用滑块并提示「不会发送」，但**保留用户数值**（切回支持采样的 model 自动恢复，浏览器 smoke 已验证保存后值仍在）。

- Anthropic wire contract 收敛（P20 已完成）：**建立唯一的 Anthropic request normalization**，Browser / Node 对同一 canonical 输入生成语义等价的 Anthropic body。唯一真源 = `assets/js/ib-model-core.js` 的 `normalizeAnthropicMessages(prompt, spec)`（纯函数）：候选 system 文本顺序为「顶层 system → messages 里按出现顺序的 system」，**完全相同（忽略首尾空白）的文本只保留一份**（consumer 普遍把同一段 system 同时放进两处，去重后与 P20 之前的浏览器语义逐位相同），不同的用 `\n\n` 连接（多条 system 一条不丢、顺序稳定），都没有时回落 `spec.systemPrompt`；`messages` 只保留非 system 项（逐条浅拷贝，冻结输入零 mutation）。canonical 契约里 system content 是 **string**，block 数组/`{text}` 只做最小安全兼容，**绝不** `String(content)`。无法映射的 role（`tool` / `developer` / 自定义）**不静默删除**，保留原样交 provider 判定并记入 `unmappedRoles`。`communication.js` 三处 anthropic builder（`callApi` / 流式 / 非流式）统一经 `_ibAnthropicWire()` 转调该函数；`active/node-model-port.js` 只搬 transport（body 全部由 core 产出），故 Moments / Scheduler / 回复链 / Proactive 自动继承。**只共享纯请求形状归一**：fetch 生命周期、SSE 解析、AbortController、retry UI、`cache_control` 断点、浏览器直连头、telemetry、Cache Audit 仍各自留在原 runtime，core 保持零 window / 零 DOM / 零 fetch。已知/有意保留：① `ib-bridge-service.js` 的 AI 常驻调用与 `test_chat_smoke_provider_contract.js` §0 的 Node 预检小工具仍各自构造 anthropic body（前者是独立本地服务、用自己的会话历史且本就满足「messages 无 system」，后者只做 mock 路由自检），**不是第二份归一**；② `tool_choice` 两侧都不发送（Browser 只在 Cache Audit 里读它），`tools` 仍由 Browser 的 IBFC/IBWS 提供、Node 端口不支持 —— 属真正的 Tool Runtime 能力差异，P20 未扩大范围；③ Browser adapter 的 canonical 输入是 `messages[]`（system 在数组内），`cfg.systemPrompt` **不会**叠加进 anthropic body（workspace 等 consumer 已在 system 消息里自带扩展指令），Node adapter 是 `{system, messages}`：两者调用同一函数、同一规则，差异只在输入包装形态；④ `validateAnthropicRequestBody` 是纯诊断函数，生产路径不据此抛错（IB 没有 body 级 fail-fast 契约）。

已登记未实施：**P21 · Native Vision Media Normalization**（聊天附件 / `ws_read_image` / tool image / visionReference / 群聊 → request-local media normalization → provider 支持的 MIME；BMP/SVG 在 request-local 栅格化，**不改 canonical storage**）；**P22 Candidate · Transport Profiles**（provider + transport profile 契约，含 DeepSeek 官方 `/anthropic`；禁止裸 `format` 字段）；**Future · Read-only Model Probe**。P20 明确**未**实施：DeepSeek `/anthropic`、API config `format` / transport selector、Vision MIME 归一（BMP→PNG / SVG 栅格化）、`/models` 探测、Model Registry / Marketplace、Structured Outputs 框架、Provider 默认模型改动、用户配置迁移、Provider Presentation 改动、Tool Runtime / stream parser 重构、canonical storage 改动。


---

*本文档只描述代码事实与已配置状态，不包含任何密钥原文。历史细节见 [CHANGELOG.md](CHANGELOG.md)。*
