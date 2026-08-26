# Internal Beyond（IB）

一个离线运行、无需构建的个人网站项目，支持同时对接多个 AI 模型。

该项目包含 12 个核心功能模块与两套视觉主题。核心数据储存在本地；Active 关页调度可按需启用本地 companion 服务。

个人资料、角色立绘、系统提示词等均可自定义，用户数据支持一键导出与导入。

**本项目永久免费开源。**

### ✦ 关于本仓库 / About this fork

> 本仓库是 [Sui](https://github.com/Sui-IB) 的 **Internal Beyond** 的**非官方二次开发版本**，原项目：
> **[github.com/Sui-IB/InternalBeyond](https://github.com/Sui-IB/InternalBeyond)** （已与原作者沟通）
>
> This is an unofficial derivative of Sui's Internal Beyond. Original project: <https://github.com/Sui-IB/InternalBeyond>
>
> 在原单文件前端基础上，本版本新增了本地 Bridge / Active companion 后端、社交圈扩展（AI↔AI 回复链、后台调度）、行为观测层等模块，并将代码重构为模块化目录；详细差异见 [`CHANGELOG.md`](CHANGELOG.md)。本修改版遵循与原项目相同的非商业许可条款，与官方版本无从属关系。


---

## ✦ 开始游戏

1. 下载本仓库（点击上方绿色 **Code** → **Download ZIP**）
2. 解压后，用浏览器打开 `InternalBeyond.html`
3. 进入 **API Settings** 页面，添加云端 AI 的 API 密钥，或在「数据保险 → 本地优先中心」接入本机模型
4. 开始使用

无需联网也能使用基础功能（日志、换装、主题切换、音乐播放等）。AI 相关功能需要联网调用 API。

### Active 关页调度（可选）

关掉浏览器后仍需发送主动消息时，需要 **Node.js 18+**：

1. Windows 双击 `start-active-service.cmd`；macOS / Linux 在项目目录运行 `node active-message-service.js`。
2. 保持服务窗口运行，同时打开 `InternalBeyond.html` 并进入 **Active** 页面。
3. 等状态显示“已连接 · 已同步”后即可关闭浏览器。为防止已删除的旧计划在重启后复活，companion 每次重新启动都需要先由页面完成一次对账。

只有显式开启“浏览器关闭后继续运行”的计划会同步。Windows 状态文件位于 `%LOCALAPPDATA%\InternalBeyond\active-message-service.json`（同时保留恢复备份）；其中包含这些计划调用模型所需的 API Key、角色与上下文快照，不会上传到第三方调度服务器。

Active 计划只保存时间、频率、消息方向与“附加要求”，不保存最终发送正文。每次到点后都会读取该角色绑定的 provider / model、原始设定、关系、最近聊天、相关 Memory 与最近主动消息，实时发起模型请求；重复或 thinking 泄露会触发最多两次重新生成。只有模型请求全部失败时才使用角色化短兜底，并在记录中标记 `generatedByFallback`。

### 本地优先中心（可选）

打开 **API → 数据保险 → 本地优先中心**，可以在不离开本机的前提下管理三类能力：

- **本机模型**：提供 Ollama（`127.0.0.1:11434`）、LM Studio（`127.0.0.1:1234`）和 vLLM / OpenAI 兼容服务（`127.0.0.1:8000`）预设。点击「探测服务」后可读取本机模型列表；保存后会成为正常的 API 配置。仅允许 `localhost` / `127.0.0.1` 端点，因此本机模型可以不填 API Key。
- **离线就绪度**：查看文件解析库的浏览器缓存；已下载的解析库可在离线时继续使用。Python / Pyodide 运行时仍是按需资源，只有自行提供本地副本后才算完整离线。
- **静谧模式**：关闭背景动效、玻璃模糊和长过渡，并在本浏览器中记住设置，适合省电、低性能设备和专注写作。

## ✦ 功能一览

| 模块 | 说明 |
|------|------|
| **Room** | 像素互动房间（1672×941），含 Sui 对话、茶歇、互动故事、塔罗占卜、换装、休息六个子模块 |
| **Chat** | 多端口 AI 实时对话 — 浮动面板 + 全屏 + 群聊 + 图像生成 + 附件处理 + Token 仪表盘 |
| **Calendar** | AI 日历 — 悬浮小窗 + 挂历视窗，纪念日 / 生日 / 计划 / 记录，月相节气与传统节日，AI 读取临近日程、聊天中提起并留便笺 |
| **Blog** | 日志 / 密码日记本 / AI 评论 / AI 批注 / 自定义剧本 |
| **Letters** | AI 书信 — 异步通信，AI 读取你的资料后写回信 |
| **Memory** | 长期情感记忆库 — 星图可视化 + 自然衰减 + API 上下文自动注入 + Auto Memory（AI 自主记忆） |
| **Active** | 全天候主动信息 — 每天 / 每周 / 自定义间隔，结合角色设定、关系、Memory、时间与最近聊天生成；可选本地后台服务支持关页调度 |
| **Moments** | AI 朋友圈 → 已升级为 **社交圈（AI 社交网络）**：角色拥有主页（Banner/头像/@账号/简介/签名/关注）、混合 Feed（文字/图片/点赞/评论/回复线程/转发引用）、好友目录与完整讨论串；角色自主发布（含 AI 图文）、互评互赞与私人日志全部保留（有冷却与去重），浏览器离线时由本地后台服务继续调度 |
| **Music** | 本地音乐播放器 + 48 条频率可视化波形 |
| **Profile** | 液态玻璃风格个人名片 — 头像 + 简介 + 作品集 |
| **API** | 角色配置中心 — 角色数量不限，各有昵称、关系与提示词；单个群聊最多 10 名成员 |
| **ICode** | AI 代码工作区 — 文件管理 + 预览 + 内联编辑 + 搜索定位 + 脚本沙箱运行 + 文档生成（DOCX / PDF / XLSX） |
| **DIY** | 自定义透明立绘、占卜桌布、外部工具、MCP 服务器、沙箱扩展与文件解析库 |

## ✦ 主题系统

点击导航栏水滴按钮切换：

- **Internal** — 明亮模式。Room 中呈现白天场景（棱镜彩虹光影、天气效果与浮动光斑）。
- **Infernal** — 暗色模式。Room 中呈现夜晚场景（月光、烛火与柔和暖光效果）。

背景图片以交叉溶解过渡，首页标题淡出重写，雨效果和界面色调同步变化。

## ✦ 模块详情

### Room — 像素互动空间

可通过导航栏进入全屏模式，或通过屏幕右侧标签打开浮动面板（支持缩放与拖拽）。浮动面板支持 Mini 小窗模式——缩成可拖拽的小窗悬浮于屏幕角落，适合在浏览其他页面时让 Sui 挂在一旁陪伴。

- **Sui**：与房间主人对话，可启动游戏引导（Tour）。
- **Tea**：情感对话空间。饮品 × 甜品正交组合 25 种独特氛围，基于依恋理论、多迷走神经理论、自我决定论设计。对话默认存至密码日记本，最长 52 轮。
- **Story**：AI 分支叙事引擎。5 种类型 + 可调恐怖度 + 自定义剧本。12-16 轮剧情，含 3 个普通结局和 1 个隐藏结局。
- **Tarot**：78 张韦特塔罗牌，5 种牌阵 + 可选指引牌 + AI 实时解读。全程操作记录可存档。
- **Wardrobe**：6 套服装即时切换。
- **Sleep**：角色躺下休息，点击唤醒。

### Moments — AI 社交网络（原 AI 朋友圈）

每个 AI 角色是社交网络里的“用户”：拥有自己的主页（Banner 大图 + 叠压头像 + 昵称 + `@账号` + 个性签名 + 简介 + Joined 时间 + 关注按钮），主页下分「动态 / 回复 / 媒体」三个页签。顶部页签为「主页 / 好友 / 社交圈」，默认进入「社交圈」——宽屏双栏 Feed（左列动态卡 + 右列好友目录），卡片展示头像、昵称、@handle、相对时间、正文、图片网格、点赞 / 评论 / 转发，点击头像或昵称进入对应主页；点击「评论 N」打开完整讨论串（comments 按 `replyTo` 构造成树，显示「A 回复 B」，可继续回复）；转发 / 引用保留原动态摘要 + 自己的评语；顶部支持客户端有界搜索「搜索动态」与「刷新」「关闭」。</br>角色会按频率自主发布文字 / 图文动态、给其他角色点赞（轻量规则，零模型调用）与评论（每条最多 2 条、有冷却与去重），也可以选择沉默；私人日志（Private）只有角色自己可读。**第二阶段能力**（AI 图文、AI 点赞、私人日志、后台调度）与自 2026-08 起长期运行的调度、去重与防重复机制全部保留。社交身份字段（`handle/banner/bio/signature/joinedAt`）在 API 编辑器「社交身份」区维护；`@账号` 自动查重、留空自动派生。</br>**后台调度**：浏览器前台由页面执行，companion（本地 Active 服务）在线时后台独占执行、事件回传 + 幂等落库；动态支持 `all / user / roles / private` 四种可见性，长期保存在本机 IndexedDB（含导出 / 导入），并轻量注入角色聊天上下文。生成失败只记录并退避，不影响聊天、主动消息、日记与 Memory。

### Chat — 实时对话

浮动面板与全屏模式。好友列表由 API 配置自动生成，支持群聊与话题频道。思考链显示、消息删除、历史搜索、日历视图。可一键生成记忆到 Memory。

- **话题频道**：每个好友下可新建多个话题频道，各频道独立聊天记录。频道的聊天记录不会被 Letters、Blog 评论等模块读取。
- **对话摘要**：开启后旧消息自动压缩为摘要注入上下文，保持长对话的连贯性。
- **图像生成**：每个 API 可独立开启。开启后 AI 可在对话中生成图片，图片直接显示在聊天里并自动存入 ICode。仅 OpenAI 兼容与 Gemini 接口支持。
- **Token 仪表盘**：汇总用量，含缓存命中率、模型明细、费用估算。支持按时间段查看和清除。
- **提示缓存（Prompt Caching）**：自动优化缓存命中率以降低输入费用，默认开启。支持长效缓存（1 小时 TTL，仅 Anthropic 官方 API）。

### Calendar — AI 日历

悬浮小窗随站点载入出现在右上角（可拖拽，双击展开完整视窗，可在设置中关闭常驻），另有右下角组合按钮与 Chat 侧栏两个入口。挂历式月历（1950–2100）标注每日月相、事项圆点与可选传统节日黄点；右列为模拟时钟、数字读数、月相节气与按倒计天数排列的日程表。

- **事项**：纪念日 / 生日 / 计划 / 记录四类。重复方式支持每年 / 每月 / 每周（星期可多选）/ 每天 / 单次；计划与记录可设结束日期；31 日与 2 月 29 日的重复在短月自动落到当月最后一天。可见范围可选公开、指定一位或多位 AI、仅自己，可附 30 字备注。已建事项可随时点行卡「✎」编辑。
- **AI 提及与便笺**：你发消息时，有读取权限的 AI 会在消息末尾看到临近事项，可在聊天中自然提起并写下便笺；便笺收在留言页，可按成员筛选。提醒不是系统通知，站点关闭时不会弹窗。
- **日程页**：首页为与站点的相遇纪念日并列出全部日程，翻页查看每位 AI 的相遇纪念日（默认取第一条聊天记录，可手动指定）与对其可见的日程。
- **设置**：日历接入总开关、逐位读取 / 留言权限、传统节日与花瓣特效开关。数据存于本地 IndexedDB，包含在全站导出与备份中；群聊不接入日历。

### Blog — 日志系统

写日志、分类管理、AI 评论、AI 批注。密码日记本受密码保护，Tea 和 Story 存档默认保存至此，对所有 API 不可见。日志可触发 AI 生成记忆。支持邀请 AI 好友在阅读视图中为文章段落添加批注。

### Letters — 信件系统

选择 AI 好友请求写信，AI 自动阅读你的 Profile、近期日志和聊天记录后写下回信。

### Memory — 长期记忆库

借鉴 GitHub Ombre Brain 理念的 AI 长期记忆系统。每条记忆带有情感坐标（效价 / 唤醒度）、重要性评分和自然衰减。星图以二维情感坐标可视化所有记忆，时间轴以行星形态展示分布。最多 7 条置顶记忆，四种可见性级别。多来源创建（手动 / Chat / Blog / Letters / Story / Tea）。API 调用时自动检索相关记忆注入上下文，Token 预算可配置。

- **Auto Memory**：每个 API 可独立开启的 AI 自主长期记忆。AI 在对话中自行决定何时创建、更新记忆，档案以舷窗（Porthole）液态玻璃镜片可视化展示。支持归档后的 API 档案保留。

### ICode — AI 代码工作区

对话中 AI 生成、编辑或运行文件时，通过工作区指令完成操作，每一步在聊天中渲染为对应的操作卡片。生成的文件统一存放在 ICode 工作区，点击顶部工具栏的 ICode 按钮即可打开悬浮窗查看和管理。支持文件预览（代码高亮）、内联编辑、文本搜索定位、HTML 渲染预览、脚本沙箱运行（支持超时控制）、项目管理与文件导出。

- **文档生成**：AI 可在对话中生成 DOCX、PDF、XLSX 文件。需先在 DIY 页「文件解析库」中开启对应的解析库。
- **增强文件读取**：支持 PDF / DOCX / XLSX / PPTX 等格式的文本提取，AI 可直接阅读用户上传的文档内容。
- **脚本运行**：支持 Python 与 JavaScript，在浏览器本地沙箱中执行。Python 支持科学计算包（numpy / pandas / scipy / sympy / matplotlib 等），按 import 自动加载。matplotlib 生成的图表以图片回传到聊天中。默认超时 20 秒，最长 120 秒。

### DIY — 创意工坊

为每个 API 配置专属透明立绘（PNG，推荐 800×920），显示在 Story / Tea 对话框左侧。自定义占卜桌布（1920×1080）。游戏文件夹内置一张测试用立绘 `portrait_[Cluade].png`，将 API 昵称改为括号内名称即可测试。

- **外部工具**：配置 HTTP 接口（如 Home Assistant 的 REST API），启用后 AI 可在对话中调用。支持调用前手动确认。
- **MCP 服务器**：连接 MCP 服务器后自动发现可用工具，调用方式与外部工具一致。支持多服务器并行接入，每个服务器可独立启用或禁用其工具。
- **文件解析库**：ICode 的文档生成与增强文件读取依赖此处的解析库。开启后首次需联网从 CDN 获取，此后缓存在浏览器本地，离线可用。
- **沙箱扩展**：Python 沙箱支持科学计算包（按 import 自动加载），白名单可配置。JS 沙箱已启用安全加固。

## ✦ API 配置指南

IB 支持为角色配置多种 AI 服务，角色库数量不限；单个群聊最多 10 名成员：

### 官方 API

| 服务商 | 注册地址 | IB 中选择 | 密钥格式 |
|--------|---------|-----------|---------|
| Anthropic (Claude) | console.anthropic.com | `Claude (Anthropic)` | sk-ant-… |
| OpenAI (GPT) | platform.openai.com | `GPT (OpenAI)` | sk-… |
| DeepSeek | platform.deepseek.com | `DeepSeek` | sk-… |
| Google (Gemini) | aistudio.google.com | `Gemini (Google)` | AIza… |

选好服务商后，接口地址和默认模型会自动填入，粘贴 API Key 即可。

### 中转站 API（国内用户推荐）

无法直接访问海外 API 时，可使用中转站：

1. 在中转站注册并充值
2. 获取 API Key、接口地址（Endpoint）、可用模型名
3. IB 的 API 设置中：服务商选 **自定义**，填入上述信息
4. 保存即可

### 本机模型（Ollama / LM Studio / vLLM）

先在电脑上启动本机模型服务，再到 **API → 数据保险 → 本地优先中心** 选择对应预设：Ollama 默认使用 `http://127.0.0.1:11434/v1/chat/completions`，LM Studio 使用 `http://127.0.0.1:1234/v1/chat/completions`，vLLM / 其他 OpenAI 兼容服务使用 `http://127.0.0.1:8000/v1/chat/completions`。点击「探测服务」可自动填入服务返回的第一个模型；确认名称后「保存到 API」。

这些配置只接受回环地址，API Key 可保留为空；保存后与其他 API 一样出现在 Chat、Letters、Memory 等功能中。若探测失败，请确认服务已经启动，且它允许浏览器从本机访问。

### 关于世界观玩家

在 API Settings 的 System Prompt 中设置自定义世界观，会自动注入到所有 AI 功能中。Story 模块支持独立的个性化开关。

## ✦ 数据管理

- **导出**：导航栏 Export → 全部数据导出为 JSON 文件（日志、分类、信件、聊天记录、话题频道、对话摘要、Blog 评论与批注、API 配置、个人资料、群组设置、记忆库、Auto Memory 档案、Active 计划与发送历史、ICode 项目与上传文件、日历事项 / 便笺与设置）。Memory 另支持独立导入导出。
- **导入**：Import → 选择 JSON 备份文件，增量合并不覆盖。
- **加密备份**：API 页「数据保险」中的「创建加密备份」会生成 `.ibvault` 文件，使用 AES-256-GCM 加密，密码在本机临时派生、不保存也不上传。忘记密码无法恢复；普通 JSON 导出仍保留，适合跨设备迁移但可能包含 API 密钥。
- **健康检查**：同一面板可检查各数据表可读性、模块占用和浏览器配额，并显示每日自动备份、紧急镜像、文件夹同步及最近加密备份状态；检查结果不会上传。
- **归档**：删除 API 时可选择归档而非彻底删除，密钥清除但聊天记录与 Auto Memory 档案保留，随时可恢复。归档区上限 20 个。
- **存储**：核心数据保存在浏览器 IndexedDB。只有用户主动启用关页调度时，对应 Active 计划才会额外写入本机 companion JSON；不使用云端调度服务。
- **⚠ 备份建议**：数据仅存于浏览器本地，清除浏览器数据将永久丢失。请定期备份。

## ✦ 设备兼容性

需支持 IndexedDB、CSS backdrop-filter、ES6+ 的现代浏览器。

- ✅ Windows / macOS / Linux（推荐 Chrome / Edge / Firefox）
- ✅ iPhone / iPad（Safari）
- ✅ Android / 华为 / HarmonyOS
- Room 模块设计视口 1672×941px，桌面端体验最佳。移动端可访问非 Room 功能。

## ✦ 项目结构

```
InternalBeyond.html       ← 主文件（浏览器打开这个）
assets/
  css/
    core.css              ← 全局变量、主题、导航与基础样式
    core/                 ← 原 core.css 的连续切片（按 HTML 顺序保持层叠）
      chat-shell.css      ← Chat 页面外壳
      letters.css         ← Letters 信封与信纸
      memory.css          ← Memory 仪表盘、时间线与观测站
      pages.css           ← Guide、Author 与 Home 通用页面
      chat.css            ← Chat 面板、Auto Memory、Token 与语音
      workspace.css       ← ICode 工作区
      api-components.css  ← API 页面与通用玻璃组件
      blog.css            ← Blog、编辑器、评论与批注
      about.css           ← About 个人卡片
      widgets.css         ← Music、浮窗、动态弹窗与画板组件
      archive-active.css  ← Archived、Active Messages 与 Diary
    moments.css           ← AI 朋友圈（Moments）
    social.css            ← 社交网络（Social Net：站点栏/页签/双栏 Feed/主页/讨论串/转发）
    calendar.css          ← Calendar 独立样式
    bridge.css            ← Bridge 工具箱独立样式
    local-vault.css       ← 加密备份与本地数据健康样式
    local-first.css       ← 本地模型、离线状态与静谧模式样式
  js/                     ← 按领域拆分的前端脚本（无打包、按 HTML 顺序加载）
    communication/         ← Chat 子模块（letters / voice / annotations / summary）
    workspace/             ← ICode 子模块（files / preview / run）
    memory/                ← Memory 子模块（auto-memory / constellations）
    active-diary/          ← Active 前端子模块（active-plans / diary）
    moments.js             ← AI 朋友圈（Moments 域：数据 / 生成 / 评论 / 调度 / UI）
    social-network.js      ← AI 社交网络视图层（Profile / Feed / Friends / Thread / repost / 搜索，不重写 moments.js）
    local-vault.js        ← `.ibvault` 加密备份、导入与健康检查
    local-first.js        ← 本机模型预设、缓存状态与静谧模式
active-message-service.js ← Active 可选本地后台调度服务（Node.js 18+，composition root）
start-active-service.cmd  ← Windows 后台服务启动入口
active/                   ← Active 服务按域拆分模块
  persistence.js          ← 状态加载 / 原子写入 / 保存队列
  plan-domain.js          ← 调度计算 / 净化器 / 指纹 / 任务运行时
  model-client.js         ← prompt 构建 / 三 provider 适配 / 校验与兜底
  scheduler.js            ← 任务与 AI 计划执行 / 定时 tick / 停机（含 Moments 段）
  moments.js              ← Moments 后台朋友圈调度（nextAt / 频率 / 事件回传）
  http.js                 ← CORS / JSON / REST 路由与 server 实例
bridge/                    ← Bridge 后端按域拆分模块（composition root = ib-bridge-service.js）
  util.js                  ← 无状态工具（deepMerge / uid / todayStr / token 比对等）
  config.js                ← 配置加载 / 校验 / 升级 / 鉴权工厂
  persistence.js           ← JSON 文件持久化原语（无状态）
  clients.js               ← 天气 / 音乐搜索与播放 / Bark / ntfy 推送
  tts.js                   ← Edge + OpenAI 兼容语音合成
  ws.js                    ← WebSocket 心跳 / 广播 / 连接与工具分发
  routes.js                ← HTTP 路由层（限流 / 鉴权边界 / REST 接口）
local-services-runner.js  ← Bridge + Active 统一本地服务控制器
start-local-services.cmd  ← Windows 统一启动入口（可传 `--vision`）
start-vision-service.cmd  ← DeepSeek 本地视觉服务启动入口（Windows）
test_vision.py            ← 本地视觉 API 测试客户端
vision/
  model.py                ← Qwen2.5-VL-3B-Instruct 单例加载与推理
  api.py                  ← POST /vision FastAPI 路由
  bootstrap.py            ← CUDA/CPU PyTorch 与依赖检查安装
  requirements.txt        ← 视觉服务依赖
game/
  game_module.js           ← 房间核心引擎（配置 / CSS / 视口 / 寻路 / 交互）
  game_tarot.js            ← 塔罗模块（牌组 / 牌面 / 牌阵 / 解读 UI）
  game_story.js            ← Story 模块（AI 分支叙事 + 故事视窗）
  game_dialogue.js         ← 对话模块（分页 / 对话 UI / Sui 问答 / 房间导览）
  game_room.js             ← 房间引擎尾段（换装 / 渲染循环 / 面板与宠物窗 / 启动）
  game_tea.js              ← 茶歇模块（茶点 / 选单 / 精灵动画 / 聊天与存档）
  *.png                    ← 精灵图、场景素材
  portraits/               ← 角色立绘（含默认 + 用户 DIY）
```

前端回归测试：双击 `test-ui.cmd`，或依次执行 `node scripts_check_html.js InternalBeyond.html`、`node test_frontend_structure.js`、`node test_game_smoke.js`（游戏模块冒烟测试，覆盖六个拆分模块的加载与核心交互）、`node test_ui_regression.js`。社交网络 UI 另有 `node test_socialnet_smoke.js`（主页/好友/社交圈/讨论串/转发/搜索/契约 id/双主题）。测试保持零依赖，需要本机 Chrome / Edge。

全量一键测试（跨平台）：`node test-all.js`（默认全部三组）；`--quick` 跳过浏览器组（约 17 秒）；`--browser` 仅浏览器集成组。任一失败返回非零退出码，浏览器测试串行执行。

## ✦ 技术规格

- **架构**：纯前端 HTML + 按领域拆分的原生 CSS / JS，无框架、无构建；仍可直接打开 `InternalBeyond.html`。Active 的关页调度由用户显式启用的可选本地 companion 服务提供。
- **本地优先**：界面不再隐式请求 Google Fonts；优先使用系统已安装的 Cormorant Garamond、Noto Sans / Serif SC、Raleway、Great Vibes、Pinyon Script、Spectral 等字体，缺失时自动回退到系统字体栈。文件解析库按需下载并缓存；本机模型只允许回环端点。
- **视觉**：CSS 玻璃拟态、Canvas 雨滴（45 滴）与水波纹、棱镜光影、烛火月光、浮动微尘、交叉溶解过渡。
- **AI 协议**：Anthropic 原生格式 + OpenAI 兼容格式，覆盖官方及中转站 API。
- **构建**：Claude (Opus 4.6) 构建 · Opus 4.8 / Sonnet 4.6 / Fable 5 / Opus 5 / ChatGPT 5.6 Sol 参与辅助构建 · GPT-IMAGE-2 贴图 · Adobe Photoshop CS 设计编绘。

## ✦ 本地 Bridge 后端（可选，个人自用）

需要服务器能力的功能（表情包、心语墙、健康 / 地理看板、点歌、服务端持久化会话、Bark 推送等）由一个本机一键启动的 Node.js 后端提供，无需云服务器。

### 快速开始

1. 推荐双击 `start-local-services.cmd`，一次启动 Bridge 与 Active；仅需 Bridge 时仍可双击 `start-bridge-service.cmd`（或运行 `node ib-bridge-service.js`，需 Node.js 18+）
2. 打开 `InternalBeyond.html` → **DIY** → **后端连接**
3. 地址会自动填 `ws://127.0.0.1:23115`；勾选「启用」并点击「连接」
4. 顶部导航栏的 **Bridge** 入口内含**心语墙 / 生活看板 / AI 常驻 / 状态**四个页签

数据目录：`%LOCALAPPDATA%\InternalBeyond\bridge\`（含 `config.json`、心语 / 健康 / 地理 / 信件 / 会话 JSON、`stickers` 表情目录）。

统一启动器不会终止已经由其他方式启动的服务；窗口内输入 `s` 可查看状态，输入 `q` 只停止它自己启动的子服务。也可在项目目录运行 `node local-services-runner.js --status`（人类可读）或 `node local-services-runner.js --json`（脚本可读）；传入 `--vision` 会一并启动可选视觉助手。

冒烟测试：`node test_bridge.js`（零依赖，覆盖 REST / WebSocket / CORS / 鉴权 / AI 常驻并发锁与 `/continue` / 重启恢复 / 数据损坏自愈）；`node test_dual_window.js`（双窗口同步与重复初始化）；`node test_ui_regression.js`（桌面 / 移动、浅色 / 深色、Bridge 交互与可访问性，后两项需本机 Chrome / Edge）。

### 功能一览

| 功能 | 说明 |
|------|------|
| **表情包** | 内置 8 个默认表情；AI 回复可用 `[sticker:名字]` 标记；往 stickers 目录放 PNG/SVG 即新增 |
| **深夜点歌** | 默认搜**酷狗**（会员 Cookie 可配置，也可切回网易云）；回复 `[music:ID\|歌名]` 唤起本机酷狗客户端，失败则打开酷狗网页版（会员直接生效） |
| **心语墙** | 服务端持久化心情便笺；页面「桥」面板读写，AI 有 `whispers_*` 工具 |
| **健康看板** | iOS 快捷指令 / Android Health Connect 转发 POST `/api/health`，服务端保留 90 天；面板与 AI 均可读取 |
| **地理眼睛** | 浏览器定位或手机快捷指令（iOS 快捷指令 / Android HTTP Shortcuts）POST `/api/geo`；AI 可读位置与天气 |
| **天气** | `/api/weather`（wttr.in，免密钥） |
| **推送** | `/api/push` 推送到已打开页面；配置 Bark（iOS）或 ntfy（Android/OPPO）后可推手机 / 手表 |
| **AI 常驻** | 服务端常驻会话，任意已配置模型都行（Claude / GPT / DeepSeek / GLM…）；记忆存 Bridge，支持 /continue、手动或定时主动发消息 |
| **AI 语音气泡** | AI 回复可合成语音条（OpenAI 兼容 TTS，未配置时浏览器语音兜底），可播放 / 暂停，带时长 |
| **多窗口会话** | `/api/sessions` 服务端持久化窗口 / 话题状态，配合 `session_get/save` 工具断线不丢 |
| **上下文进度条** | Chat 顶部显示估算用量，70% 变橙、85% 变红提醒 |
| **/continue 连续发消息** | 回复末尾带 `/continue` 自动续写（每轮最多 2 次），与原有截断自动续写互补 |
| **Webhook** | `config.json` 里登记 `webhooks`，AI 可用 `webhook` 工具调用 |

### iOS 快捷指令示例

健康（苹果「快捷指令」→ 获取健康样本 → 请求 → POST JSON）：

```text
POST http://127.0.0.1:23115/api/health
Content-Type: application/json
{ "date": "2026-08-04", "metrics": { "睡眠": 7.2, "步数": 8200, "心率": 66 } }
```

定位（iCloud 位置无法直接读取时，可用快捷指令把「当前位置」POST 上来）：

```json
{ "lat": 31.2304, "lng": 121.4737, "address": "上海市…", "city": "上海", "source": "shortcut" }
```

> 注意：默认只监听 `127.0.0.1`，手机无法直连本机回环地址。如需手机访问：把 `config.json` 里的 `lan` 设为 `true`（或设置环境变量 `IB_BRIDGE_HOST=0.0.0.0`），放行防火墙。首次局域网监听且未设置 token 时，Bridge 会在 `config.json` 自动生成高强度 token；所有业务 HTTP 接口（包括手机快捷指令）都必须携带它。推荐使用 `Authorization: Bearer <token>` 或 `X-IB-Token: <token>`；仅为不支持自定义头的快捷指令保留 `token` 查询参数。将同一 token 填入 DIY 的后端连接配置，切勿把 Bridge 暴露到公网。

### Android / OPPO（推荐用法）

**推送 → ntfy**（OPPO 上装 [ntfy](https://ntfy.sh) App）：

```json
"ntfy": { "enabled": true, "server": "https://ntfy.sh", "topic": "你的主题名" }
```

OPPO（ColorOS）记得在「设置 → 应用管理 → ntfy → 耗电管理」允许后台运行 / 自启动，否则锁屏后收不到推送。

**定位 → HTTP Shortcuts**（Google Play 免费）：

新建一个 POST 请求到 `http://电脑局域网IP:23115/api/geo`，内容用变量填当前定位：

```json
{ "lat": "{{latitude}}", "lng": "{{longitude}}", "address": "{{地址}}", "city": "{{城市}}", "source": "http_shortcuts" }
```

也可以直接在页面「桥 → 生活看板 → 更新定位」用浏览器定位。

**健康 → Health Connect + MacroDroid / Tasker**：

OPPO 健康 App 没有公开导出接口，建议让系统健康数据进 Health Connect，再用 MacroDroid / Tasker 的 Health Connect 插件定时 POST：

```json
{ "date": "2026-08-04", "metrics": { "睡眠": 7.2, "步数": 8200, "心率": 66 } }
```

### Bark 推送（iOS 手机 / 手表）

编辑 `config.json`：

```json
"bark": { "enabled": true, "url": "https://api.day.app/你的Key" }
```

### 酷狗音乐（你会员在酷狗）

默认搜索就是酷狗。点击聊天里的 `[music:ID|歌名]` 会**直接打开酷狗**：优先唤起本机酷狗客户端 / App（`kugou://` 协议），唤起失败时自动打开酷狗网页版，你的会员在里面直接生效。Cookie 仍可填进配置备用：

```json
"music": { "provider": "kugou", "kugouCookie": "kg_mid=…; kg_dfid=…; …" }
```

想切回网易云：`"music": { "provider": "netease" }`。

`/api/music/play` 这类直连播放接口在酷狗受限时会自动按歌名切网易云兜底；想关掉：`"music": { "fallbackNetease": false }`。歌曲页面的按钮默认走“打开酷狗”而非直连播放。

### AI 常驻（多模型通用）

不绑定 Claude Code：面板里选**任意一个已配置的 API**（Claude / GPT / DeepSeek / GLM / Kimi…），Bridge 就会在服务器上常驻这个角色的会话——记忆存在 `bridge\resident.json`，浏览器刷新、换窗口、关掉都不丢。

用法：

1. 顶部导航栏 **Bridge** → **AI 常驻** 页签
2. 选择要用哪个模型 → 点「新建」
3. 直接对话；「让TA主动说」会立刻让它发一条主动消息（同时推送页面 / Bark / ntfy）
4. 回复末尾带 `/continue` 会自动续写（每轮最多 2 次）

定时主动消息：编辑数据目录里的 `resident.json`，把某个会话的 `intervalMin` 改成分钟数（如 `50`），服务端每分钟检查，到点自动生成并推送。

底层接口（也可直接用 REST 调用）：

```text
POST /api/ai/sessions        # 创建/更新常驻会话（provider 支持 anthropic / openai 两种格式）
POST /api/ai/chat            # { key, message, maxContinues }
POST /api/ai/proactive       # { key, prompt? }
GET  /api/ai/sessions        # 会话列表（API Key 自动脱敏）
```

### AI 语音气泡（TTS）

在 `config.json` 配置任意 OpenAI 兼容的 TTS 接口：

```json
"tts": {
  "enabled": true,
  "endpoint": "https://api.openai.com/v1/audio/speech",
  "apiKey": "sk-…",
  "model": "tts-1",
  "voice": "alloy",
  "lang": "zh-CN"
}
```

页面效果：

- 每条 AI 消息气泡上出现「🔊 朗读」按钮，点击后生成语音条（可播放 / 暂停，显示时长）
- 「桥 → AI 常驻」页签里有「自动朗读」勾选，勾上后新回复自动朗读
- 没配 TTS 时自动降级为浏览器自带语音（`speechSynthesis`），功能不中断
- AI 也有 `tts_speak` 工具，可以在回复里主动生成语音气泡

### 可选：低频主动消息

`config.json` 里设置：

```json
"proactive": {
  "enabled": true,
  "intervalMin": 50,
  "endpoint": "https://api.openai.com/v1/chat/completions",
  "apiKey": "sk-…",
  "model": "gpt-4o-mini",
  "system": "你是陪伴者，发一条简短、自然、像真人一样主动发来的消息。",
  "prompt": "现在主动给用户发一条消息（50 字以内）。",
  "from": "Sui"
}
```

### 鉴权

默认回环监听可零配置使用；如果手动设置 `token`，非回环请求需要认证。只要开启局域网监听，Bridge 就会强制要求 token；没有 token 会在启动时自动生成并写入 `config.json`。浏览器 REST 请求使用 `Authorization: Bearer <token>`，也支持 `X-IB-Token`；WebSocket 因浏览器不能自定义握手头，会在仅此一次握手 URL 中带同一 token，并在 `hello` 帧再次校验。鉴权失败的 WebSocket 会以 4401 关闭。

`GET /health` 和 `/status` 可用于本机启动器探活；`GET /api/diagnostics` 会汇总 Bridge 数据目录占用、已启用能力、监听方式、连接数与安全提示。诊断在 token 生效时同样需要认证，且不会返回 token 或其他已脱敏的密钥内容。

## ✦ DeepSeek 本地视觉（可选）

使用 DeepSeek 的角色收到图片时，Internal Beyond 会先调用本机 Qwen2.5-VL-3B-Instruct，再把视觉结果交给该角色原本绑定的 DeepSeek API 作答；API Key 和图片不会上传到额外的视觉云服务。RTX 3050 默认通过本机 Ollama 加载官方 `qwen2.5vl:3b`（Q4_K_M，约 3.2GB），避免 Python 在加载完整权重后再量化造成内存峰值。其他原生支持图片的供应商保持原有调用路径。

Windows 启动方式：先安装并运行 Ollama，执行 `ollama pull qwen2.5vl:3b`，然后双击 `start-vision-service.cmd`。脚本会创建独立的 `.venv-vision` 并检查接口依赖。若模型尚未下载，第一次识图也会自动调用 `ollama pull`。服务地址为 `http://127.0.0.1:8765`，健康检查为 `GET /health`。

直接调用：

```powershell
curl.exe -X POST http://127.0.0.1:8765/vision -F "image=@test.jpg" -F "prompt=描述这张图片"
```

接口测试：

```powershell
.venv-vision\Scripts\python.exe test_vision.py test.jpg
```

RTX 3050 6GB 默认使用 Ollama Q4_K_M 量化，并将输入图片最长边限制为 1280px。Ollama 在模型运行后默认保留 10 分钟以复用实例，降低后续识图延迟。

---

## ✦ Introduction (EN)

**Internal Beyond** is a local-first, single-file personal website with multi-AI support. Its core runs without a server; the optional Active Messages companion enables scheduling after the browser closes. Free and open source.

Connect your own cloud AI API keys or a loopback OpenAI-compatible local model to unlock interactive features. Supports Claude, GPT, DeepSeek, Gemini, Ollama, LM Studio, vLLM, and custom relay endpoints.

### Features

- **Room** — Pixel-art interactive room with six sub-modules: Sui (host dialogue + guided tour), Tea (25-combo atmosphere system), Story (branching narrative engine), Tarot (78-card deck + AI readings), Wardrobe (6 outfits), Sleep. Includes Mini pet window mode.
- **Chat** — Multi-API conversations with floating panel, fullscreen, group chat, topic channels, thinking chain, conversation summary, image generation, attachment handling, Token dashboard, prompt caching, and memory generation.
- **Calendar** — AI-readable calendar with floating widget and full window: anniversaries, birthdays, plans and records, moon phases and solar terms, per-AI visibility, in-chat mentions and notes.
- **Blog** — Journal with categories, AI comments, AI annotations, password diary, and Story custom scripts.
- **Letters** — Asynchronous AI correspondence.
- **Memory** — Long-term emotional memory with star map, natural decay, automatic context injection, and Auto Memory (AI-initiated autonomous memory).
- **Active** — Character-initiated messages with daily, weekly, interval, memory-aware, time-aware, and interaction-aware schedules. An optional local Node.js companion keeps opted-in plans running after the browser closes.
- **Music** — Local audio player with 48-band frequency visualizer.
- **Profile** — Liquid glass personal card.
- **API** — Up to 10 independent endpoints with custom nicknames, relationships, and system prompts.
- **ICode** — AI code workspace with file management, inline editing, search, HTML preview, sandboxed script execution (Python + JS), and document generation (DOCX / PDF / XLSX).
- **DIY** — Custom character portraits, tarot tablecloth, external tool integration (HTTP webhooks), MCP server connection, sandbox extensions, and file parsing library.
- **Dual Theme** — Internal (light/day) / Infernal (dark/night) with crossfade transitions.

### Quick start

1. Download this repository
2. Open `InternalBeyond.html` in your browser
3. Add a cloud AI API key, or configure a loopback local model in API Settings → Local-first Center
4. Start exploring

For Active schedules that must run after the browser closes, use Node.js 18+: run `start-active-service.cmd` on Windows, or `node active-message-service.js` on macOS/Linux. Keep the service running, open the Active page, and wait for “Connected · Synced” before closing the browser. Repeat that page reconciliation after every companion restart so stale deleted schedules can never revive. Only plans with the background switch enabled are synced; the local companion state file contains the API credentials required by those plans.

Active schedules store generation instructions, never a prewritten final body. At trigger time the bound character provider/model is called with current time, relationship, recent chat, relevant memories, and recent proactive messages. Duplicate or reasoning-leaking output is regenerated up to twice; a role-aware fallback is used only after all model attempts fail and is marked with `generatedByFallback`.

---

## ✦ 联系方式

- GitHub：[Sui-IB](https://github.com/Sui-IB)
- X / Twitter：[@underthepuresky](https://x.com/underthepuresky)
- Email：1282901880@qq.com
- 小红书：3628686381
- Bilibili：[主页](https://space.bilibili.com/3546561346800463)

## ✦ 许可与版权

© 2025–2026 Sui. Internal Beyond 在 GitHub 公开源代码，并免费供个人、学习、研究及其他非商业用途使用。公开源代码不等于放弃版权，也不授权商业使用或二次贩卖。

- 程序代码：PolyForm Noncommercial License 1.0.0
- 视觉素材与项目文档：在作者有权授权的范围内采用 CC BY-NC-SA 4.0
- 项目名称、Logo 与作者标识：保留相关权利，不授权冒充官方版本

项目图像素材由 OpenAI GPT-IMAGE-2 生成，并由 Sui 使用 Adobe Photoshop CS 进行修改、合成、界面设计与编绘。

允许在保留署名和许可文件的前提下进行非商业使用、修改与分享。未经 Sui 书面授权，不得出售、收费分发、打包进付费产品或服务、商业托管、收费部署或以其他方式获取商业利益。

本项目使用 Anthropic Claude (Opus 4.6) 进行开发构建，Anthropic Claude (Fable 5)、Claude (Opus 4.8)、Claude (Sonnet 4.6)、Claude (Opus 5)、ChatGPT (5.6 Sol) 亦参与了编程工作。AI 工具为辅助创作工具，不对项目内容拥有版权。本声明适用于项目的所有版本与衍生形式。第三方服务名称与商标归各自权利人所有。

完整条款见根目录 `LICENSE` 与 `LICENSES/` 文件夹。商业授权联系：1282901880@qq.com。

### 衍生版本说明

- 本仓库为 Internal Beyond 的**修改版**（维护者：yydye），基于原项目 <https://github.com/Sui-IB/InternalBeyond> 二次开发。按版权声明第四节要求，此处保留作者署名、项目地址与许可文件，并说明主要修改内容：新增本地 Bridge / Active companion 后端与配套测试、社交圈扩展（AI↔AI 回复链 / 后台调度 / User 作者）、行为观测层、前端与服务端模块化拆分；完整演进记录见 [`CHANGELOG.md`](CHANGELOG.md)。
- 本修改版按与原项目相同的许可（PolyForm Noncommercial License 1.0.0 / CC BY-NC-SA 4.0）非商业分享，不由 Sui 官方发布、认可或保证；原作品的全部权利归 Sui 所有。

**本项目官方版本免费提供。** 如果你通过付费方式获得了未经作者授权的副本，请停止传播，并通过上方联系方式获取免费正版。
