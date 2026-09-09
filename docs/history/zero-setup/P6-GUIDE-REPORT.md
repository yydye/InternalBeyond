# P6 · Zero-Beginner Guide / Screenshot Pipeline 交付报告

> 阶段目标：让完全不了解编程、不知道 Node.js / API endpoint / 端口 / Bridge / PowerShell 是什么的普通用户，**只看教程**就能独立完成安装后的首次使用与常见故障处理。
> 本阶段只做内容与引导体验，没有改运行时架构、没有重构 UI、没有新增第二套设置页。

- 教程名称：**《InternalBeyond 零基础使用指南》**
- 入口：导航栏 **Guide** → 页面最前面；欢迎页「查看说明」直达
- 版本标识：`适用于 InternalBeyond · 指南版本 1.0`（默认值只在模块里一处，发行包可注入真实产品版本）

---

## 1. 修改文件

**新增**

| 文件 | 作用 |
| --- | --- |
| `assets/js/guide-beginner.js` | 零基础指南模块：12 章内容 + 渲染 + 图片失败回退 + 深链按钮 + 版本标识（运行时注入自己的样式表） |
| `assets/css/guide-beginner.css` | 指南样式，选择器全部限定在 `#guide-beginner` 内，使用 core.css 设计令牌，双主题自适应 |
| `docs/guide/annotations.json` | 截图清单（16 条）：id / 文件 / 目标选择器 / 说明文字 / 高亮区域 / 图注 / 前置动作 / 指南版本 |
| `docs/guide/shots/*.png` | 16 张真实截图（1440×900，带高亮框与说明箭头），共 7.2 MB |
| `scripts/capture-guide-shots.js` | 截图管线：真实浏览器 + 真实页面 + 全新临时配置 + 合成演示数据 + 标注 + 自检 |
| `scripts/guide-fixtures.js` | 演示数据与自检（`sk-demo-…` 占位密钥、`example.com` 端点、合成昵称/聊天/记忆/动态） |
| `scripts/cdp-lite.js` | 极简 CDP 客户端（截图管线与 guide smoke 共用，避免再抄一份） |
| `test_guide.js` | 静态契约测试（280 断言） |
| `test_guide_shots.js` | 截图管线专项测试（227 断言，真实跑一遍管线） |
| `test_guide_smoke.js` | Chrome guide smoke（38 断言） |
| `docs/history/zero-setup/P6-GUIDE-REPORT.md` | 本报告 |

**修改（全部为最小挂载）**

| 文件 | 改动 |
| --- | --- |
| `InternalBeyond.html` | **3 处、5 行**：`#page-guide` 内加 `<div class="guide-section" id="guide-beginner"></div>`；页尾加 `<script src="assets/js/guide-beginner.js"></script>`；Guide 浮动目录加一条 `<a href="#guide-beginner">零基础使用指南</a>` |
| `test-all.js` | 登记 `test_guide.js`（static）、`test_guide_shots.js` / `test_guide_smoke.js`（browser），并注明管线会真实跑一遍（约 70s） |
| `README.md` | 新增一节「零基础使用指南（Guide 页第一屏）」：章节、解耦、重生成命令、版本注入、演示数据安全 |

**没有触碰**：`middle-brain.js`（并行会话在途）、`core.js`、`social.js`、`communication.js`、`setup-wizard.js`、`diagnostics.js`、`error-catalog.js`、`provider-directory.js`、`local-services-runner.js`、`launch-internal-beyond.js`、`internal-beyond-server.js`。
样式表仍是 **20 个**，静态内联样式仍是 **≤200**，HTML 无 `<style>`、无内联 `<script>`；指南样式由模块运行时注入。

---

## 2. 教程信息架构

12 章，顺序即建议阅读顺序（也是页内目录顺序）：

| # | 章节 | 一句目标 | 截图 |
| --- | --- | --- | --- |
| 1 | 欢迎使用 InternalBeyond | 认识欢迎页、知道数据存在哪、下一步点哪个按钮 | `01-welcome` |
| 2 | 第一次设置 | 跟着向导走完 7 步就能开始对话 | `02-provider`、`03-api-key` |
| 3 | 添加 / 配置 AI | 让 IB 连上 AI 服务并确认连接是通的 | `04-test-ok`、`08-api-entry` |
| 4 | 创建角色 | 起名字 + 一句性格，它就成为好友 | `05-role`、`06-done` |
| 5 | 开始聊天 | 发出第一条消息，知道在哪看回复 | `07-chat` |
| 6 | Memory（记忆库） | 让 TA 记住聊过的事 | `09-memory` |
| 7 | 主动消息 | 让角色在你不说话时也来找你 | `10-active` |
| 8 | 朋友圈 / 动态 | 看角色动态，也能自己发 | `11-moments` |
| 9 | 语音 | 说话代替打字，或直接打电话 | `12-voice` |
| 10 | 其他主要功能 | 一句话认识剩下的入口 | — |
| 11 | 系统诊断与故障恢复 | 一个页面看懂问题、尝试修复、导出报告 | `13`–`16` |
| 12 | 常见问题 | 遇到提示先在这里找 | — |

每章固定结构：**一句目标 → 真实截图（0–4 张）→ 1–4 个操作步骤 → 必要时一个「遇到问题？」提示**。操作章节另有 1 个深链按钮（「打开 API 设置」「打开 Memory」…），共 8 个，全部指向真实存在的页面。

FAQ 10 条，直接复用 P3 文案，不另写一套措辞：
「API 密钥无法使用」/「AI 服务暂时拒绝了请求」/「连接不上网络」/「当前模型不可用」/「部分本地功能暂时不可用」/「语音生成失败」/ 后台功能暂时不可用 / 跳过首启后如何重新设置 / 如何导出诊断报告 / 如何添加第二个角色。

---

## 3. `#page-guide` 如何复用

- **不新建页面、不新建帮助 App**：只往既有 `#page-guide` 里追加一个容器，位置在页面最前面（`guide-header` 之后、原有 lore/技术说明书之前），所以「查看说明」进来的用户第一眼就是零基础指南。
- **不动既有内容**：原有「使用说明书」、技术规格、作者、版权等章节一字未改，仍在其下方。
- **目录**：既有浮动目录 `#guide-toc` 加一条「零基础使用指南」；指南自己另有一个 12 项页内目录（`#guide-beginner .gb-index`），不需要改 `core.js` 的 TOC 交互。
- **导航零改动**：仍用既有 `Guide` 导航项与 `enterSite('guide')` 路径，没有新增导航入口（测试断言 `data-page="guide"` 仍只有 1 处）。
- **样式隔离**：CSS 选择器全部以 `#guide-beginner` 开头（测试逐条断言），不动其它页面。

---

## 4. 首启章节

- 明确写出「第一次打开 IB 时，设置向导会自动出现」，并把 7 步原样列出：欢迎 → 选择 AI 服务 → 填写 API Key → 模型与接口 → 测试连接 → 创建角色 → 设置完成。
- 图文覆盖：`01-welcome`（欢迎页三个按钮）、`02-provider`（选服务）、`03-api-key`（填 Key，输入框默认只显示圆点）、`04-test-ok`（连接成功）、`05-role`（角色昵称与描述）、`06-done`（点「开始聊天」）。
- 跳过之后怎么回来：写明两条真实入口 —— 「API」页顶部的**「重新运行设置向导」**按钮；以及没有角色时聊天页上的**「开始设置」**。
- 向导可中断续做：写明「任何一步关掉都不用重来，下次打开会从上次停下的地方继续」（P4 草稿行为）。
- 第一条消息：第 5 章用 `07-chat` 说明「选好友 → 输入 → 回车/发送」，并解释逐字出现是正常的、可停止。

---

## 5. 各主要功能章节

内容全部来自**当前真实 UI**（读代码与真实页面确认，不按旧 README 猜）：

- **AI 配置**：导航「API」→「+ 添加API」→ 填 Key →「测试连接」→ 保存。API Key 定义写成「AI 服务发给你的访问密钥」，获取方式只写「请在你所使用的 AI 服务官方网站获取它」，**不硬编码任何第三方站点流程**；provider 元数据仍只来自 `provider-directory.js`。
- **角色**：一个 API 配置就是一个角色；昵称 + 系统提示词决定性格；再加角色走「API → + 添加API」。
- **聊天**：好友列表 → 输入框 → 回车/发送；逐字回复可停止。
- **Memory**：导航「Memory」看列表；聊天页「Save Memory」把最近对话整理成记忆；注入量在「API」页记忆设置里调；删掉即彻底删除。
- **主动消息**：导航「Active」→ 打开「允许角色主动联系」→「主动规划方式」选「AI 根据聊天规划」→ 设置最短间隔与免打扰 → 保存。
- **朋友圈 / 动态**：导航「Moments」→「社交圈」发布框 → 角色点赞/评论 → 右上角「朋友圈设置」。
- **语音**：输入框右侧麦克风（点一次开始录、再点一次发送）；选中角色后右上角电话按钮发起通话；通话中可开视频预览。
- **其他**：Blog 日志、Letters 信件、Diary、Room、Music、Calendar、ICode、DIY、Favorites、Apps —— 只列真实存在的入口，一句话带过，不写未实现按钮、不写未来规划。
- 视觉功能（可选、默认不装）**没有进首页教程**，符合「当前不适合普通用户就先不列」。

---

## 6. Diagnostics / FAQ

诊断章直接复用 P5 的操作路径，四张图对应四步：

```text
出现问题 → 打开「Diagnostics」（自动检查）
→ 看总体状态那行大字 + 每行分别什么状态
→ 点「重新检查」
→ 若出现「尝试修复」就点它，等它修完
→ 仍未解决，点「导出诊断报告」，把文件发给帮你的人
```

- 截图：`13-diagnostics-ok`（系统运行正常）、`14-diagnostics-degraded`（写清哪一项不可用）、`15-repair`（尝试修复按钮）、`16-export`（导出诊断报告）。
- 明确写「大多数情况下，你不需要打开任何命令窗口或开发者工具」；不教用户查端口、不看日志文件。
- 术语与 P5 一致：基础运行 / AI 聊天 / 本地增强功能 / 后台主动功能 / 语音功能 / 视觉功能。
- FAQ 的错误提示语一律与 P3 `error-catalog.js` 的 title 对齐（测试断言这些字符串确实存在于 P3 目录中）。

---

## 7. screenshot pipeline

`node scripts/capture-guide-shots.js`

| 环节 | 做法 |
| --- | --- |
| 真实页面 | 真实 `InternalBeyond.html` + 真实静态页面服务（`internal-beyond-server.js`） |
| 真实浏览器 | 本机 Chrome / Edge（headless=new），极简 CDP 客户端，零第三方依赖 |
| 稳定 viewport | `Emulation.setDeviceMetricsOverride` 固定 **1440×900**，`deviceScaleFactor=1` |
| 自动导航 | 清单里的 `prepare` 具名动作：进站、推进向导、播种数据、切页、制造 degraded 状态… |
| 自动标注 | 截图前在页面内注入覆盖层：高亮框 + 说明标签 + 连接线/箭头（按目标 `getBoundingClientRect` 定位，靠近顶部时自动翻到下方，并夹在视口内），截图后立即清除 |
| 稳定文件名 | `<id>.png` |
| 可重生成 | UI 改了重跑一次即可全部重生成；`--only 07-chat` 可只重生成某几张；`--plain` 出干净图 |
| 自检 | 图片过小（疑似空白）、尺寸与稳定 viewport 不符、内容重复、页面抛出异常、页面文本命中疑似真实密钥/令牌/邮箱 → 任一命中即非零退出 |
| 数据隔离 | 全新 `--user-data-dir` 临时目录（结束后删除）+ 演示数据写进产品自己的存储结构；**不读开发者本机任何浏览器数据** |

一次完整生成约 **70 秒**（16 张）。管线在 `test_guide_shots.js` 里被真实跑一遍。

---

## 8. annotations 格式

`docs/guide/annotations.json`：

```json
{
  "schema": "ib-guide-shots/1",
  "guideVersion": "1.0",
  "viewport": { "width": 1440, "height": 900, "deviceScaleFactor": 1 },
  "shotDir": "docs/guide/shots",
  "renderer": "scripts/capture-guide-shots.js",
  "demoData": "scripts/guide-fixtures.js",
  "shots": [
    {
      "id": "07-chat",
      "file": "07-chat.png",
      "title": "主聊天页",
      "chapter": "chat",
      "prepare": "chat-demo",
      "target": "#chat-full-input",
      "label": "在这里输入，按回车发送",
      "region": "box",
      "caption": "Chat 页：左侧是好友列表，底部是输入框与发送按钮"
    }
  ]
}
```

字段含义：`screenshot` = `file`；`target` = 页面内真实选择器；`label` = 画在图上的说明；`region` = `box`（高亮框）或 `none`（干净图）；`caption` = 图注（同时作为 `alt`）；`prepare` = 管线里的具名动作（清单数组顺序 = 执行顺序）。16 条全部有 `target` + `label` + `region=box`，没有空规划文件。测试断言：清单 ↔ 磁盘 PNG ↔ 正文引用三方一致。

---

## 9. demo / mock 数据隔离

- **演示数据**（`scripts/guide-fixtures.js`）：昵称「小助手」/「示例用户」，密钥 `sk-demo-0000…`（全 0 占位），端点 `https://api.example.com/v1/chat/completions`（保留域名），4 条合成聊天、2 条合成记忆、2 条合成动态（含 1 条评论）。
- **自检**（`auditDemo()`）：拒绝 `sk-` 非 demo 前缀、厂商密钥前缀、JWT、Bearer、非 example.com 邮箱、手机号、带密钥的链接 —— 管线与测试都先跑这道自检。
- **写入方式**：在全新临时浏览器配置里，用产品自己的存储结构（`dbPut('apiConfigs' | 'chatMessages' | 'memories' | 'moments' | 'about')`）写入；向导截图用的是**真实向导流程**创建的配置（只是把端点/密钥改写成占位值）。
- **不进画面**：开发者本机的真实 IndexedDB、真实密钥、真实聊天一律不参与 —— 临时配置目录每次新建、结束后删除（测试断言目录被删除）。
- 每张图截完都会回读 `document.body.innerText` 做一次密钥/私人数据自检，测试再独立复核一遍。

---

## 10. 生成的截图清单

`docs/guide/shots/`（1440×900，PNG，共 7.2 MB）：

| 文件 | 内容 | 高亮标注 |
| --- | --- | --- |
| `01-welcome.png` | 首启欢迎页（三个按钮） | 「第一次使用，点『开始设置』」 |
| `02-provider.png` | 向导第 2 步：选择 AI 服务 | 选一个你正在使用的 AI 服务 |
| `03-api-key.png` | 向导第 3 步：API Key（圆点遮挡） | 把 API Key 填在这里 |
| `04-test-ok.png` | 向导第 5 步：连接成功 | 看到「连接成功」就对了 |
| `05-role.png` | 向导第 6 步：创建角色 | 给 TA 起个名字 |
| `06-done.png` | 向导第 7 步：设置完成 | 点「开始聊天」 |
| `07-chat.png` | 主聊天页（合成对话） | 在这里输入，按回车发送 |
| `08-api-entry.png` | API 设置页 | 点「+ 添加API」 |
| `09-memory.png` | Memory 页（合成记忆） | 已经记住的事情都在这里 |
| `10-active.png` | Active 页 | 打开开关，TA 才会主动找你 |
| `11-moments.png` | Moments 社交圈 | 在这里发布一条动态 |
| `12-voice.png` | Chat 右上角电话按钮 | 点这里发起语音通话 |
| `13-diagnostics-ok.png` | Diagnostics 正常 | 一切正常时会这样写 |
| `14-diagnostics-degraded.png` | Diagnostics 部分不可用 | 看哪一项显示「不可用」 |
| `15-repair.png` | 尝试修复按钮 | 能修的问题，点这里自动修 |
| `16-export.png` | 导出诊断报告 | 修不好就导出报告 |

---

## 11. secret / privacy 检查

| 检查 | 结果 |
| --- | --- |
| 演示数据自检（`auditDemo`） | 通过，0 问题 |
| 管线内页面文本自检（每张图） | 通过：无真实密钥 / 厂商密钥 / Bearer / JWT / 真实邮箱 |
| `test_guide_shots.js` 独立复核 | 通过：16 张页面文本 × 6 类风险模式全部不命中 |
| API Key 是否回显 | 通过：`03-api-key` 页面文本不含 `sk-demo-`（密码框） |
| 指南正文 | 不含任何密钥、邮箱、真实数据 |
| 开发者真实数据 | 不参与：全新临时配置目录，运行后删除（测试断言） |
| 图片本体 | 无法 OCR 断言，但页面文本 + 合成数据自检覆盖了可见文本来源；截图只来自合成数据的页面状态 |

---

## 12. Chrome guide smoke

`node test_guide_smoke.js` → **38/38 ✔**（真实 Chrome + 真实静态服务 + 真实截图文件）：

- 从欢迎页「查看说明」进入 Guide；指南是页面第一块；标题真实可见、未被任何遮罩覆盖（`elementFromPoint` 断言）。
- 12 章、12 项目录、每章目标、≥40 步、10 条 FAQ、技术说明默认收起、8 个深链按钮、版本标识含清单版本号。
- 目录锚点点击后指南进入视口。
- **16 张截图逐张滚进视口并确认 `naturalWidth=1440 / naturalHeight=900`**（不是占位图），并通过真实 HTTP 200 校验第一张；每张有图注。
- 把一张图指向不存在的文件 → 显示文字占位、隐藏破图、该章步骤与目标仍在（内容与截图解耦）。
- 真实渲染文本：无底层术语 / 端口 / 裸网址，不含终端字样，含「不需要打开任何命令窗口」、API Key 安全提示、P3 文案、P5 三步路径。
- 深链跳到真实页面；指南样式不污染其它页面布局。
- 无未捕获异常、无控制台错误（忽略 favicon/资源 404 噪音）。

双主题另做了一次真实浏览器抽查（未进 smoke 断言集）：切到 Infernal 暗色主题后，指南标题 `color=rgb(224,230,242)`、面板底色 `rgba(38,48,80,0.82)`、正文可读，12 章与截图均正常。

---

## 13. quick 回归

`node test-all.js --quick`（static + service，130.3s）：

```
static  36 项 · 46.6s · 1 失败
service 16 项 · 83.7s · 全部通过
总耗时 130.3s · 1 项失败 ✘
```

- 唯一失败：`encoding.bom.assets\js\middle-brain.js` —— **并行会话在途文件**（与 P5 交付时同一处），P6 明确不触碰该文件。
- 新增登记项 **`test_guide.js` PASS**；`scripts_check_html.js` 67 个本地脚本 0 失败。

专项：

| 测试 | 结果 |
| --- | --- |
| `test_guide.js` | **280 通过 / 0 失败** |
| `test_guide_shots.js` | **227 通过 / 0 失败**（真实跑管线，67s） |
| `test_guide_smoke.js` | **38 通过 / 0 失败** |

未跑完整 browser suite（按 P6 测试预算）。

---

## 14. 已知限制

1. **没有产品版本号可用**：仓库里没有产品版本常量（`boot-state.js` 的 `VERSION=1` 是快照 schema 版本）。因此版本标识用的是**指南版本** `1.0`，默认值只存在于 `guide-beginner.js` 一处，并与清单 `guideVersion` 由测试锁定；发行包可用 `window.IB_GUIDE_VERSION` 注入真实产品版本（P7 建议这么做）。
2. **截图是 1440×900 的整屏图**：不是元素级裁切图，小屏幕（手机）下会缩得比较小；窄屏时正文会换行，但图片不重新裁切。
3. **向导截图依赖一个本机 mock AI 服务**：`04-test-ok` 的「连接成功」来自本地 mock 服务（真实请求链路、真实 UI），不会连接任何外部 AI 服务。
4. **`01-welcome` 必须在向导自动弹出前抓拍**：向导在页面就绪约 15s 后自动出现，管线抢在此之前截图；若本机极慢导致错过，管线会明确报错而不是产出一张错的图。
5. **截图未做体积优化**：16 张共 7.2 MB（`01-welcome` 单张 1.7 MB，欢迎页有动画/雨效果）。仓库可接受，但若要随发行包分发需考虑压缩。
6. **视觉功能未进教程**：视觉是高级可选、默认不安装，按 P6 第 6 条「当前不适合普通用户就先不列入首页教程」处理；只在 Diagnostics 章节里作为可选状态出现。
7. **`prepare` 动作与清单是弱耦合**：清单里写动作名，具体实现在管线里（测试断言每个 `prepare` 都有实现），新增截图需要同时改两处。
8. **深链按钮只在目标页面存在时渲染**：`file://` 或裁剪过的发行包若缺页面，按钮自动消失（正文步骤仍然完整）。

---

## 15. P7 Installer 需要引用的安装教程内容

P7 做安装包时，可以直接引用本阶段产物，不需要另写一套安装说明：

| 安装器位置 | 引用什么 | 出处 |
| --- | --- | --- |
| 安装完成页 / 首次启动引导 | 12 章目录 + 「第一次设置」整章（向导 7 步） | `#guide-beginner` 第 1–2 章 |
| 「下一步」按钮 | 直接打开 Guide 页（`enterSite('guide')` 或 `location.hash='#guide'`） | 既有入口，无需新页面 |
| 桌面快捷方式说明 | 一句「双击桌面 InternalBeyond 图标」+ 首启截图 | `01-welcome.png` |
| 安装失败的兜底提示 | 「打开 Diagnostics → 重新检查 → 尝试修复 → 导出诊断报告」 | 第 11 章 + `13`–`16` 截图 |
| 版本号 | 用真实产品版本注入 `window.IB_GUIDE_VERSION`（当前默认 `1.0`） | `guide-beginner.js` 一处常量 + `annotations.json.guideVersion` |
| 教程资源打包 | 必须随包带上 `docs/guide/shots/*.png`（7.2 MB）与 `assets/css/guide-beginner.css`；缺失时正文自动降级为纯文字 | 第 9–12 条约束 |
| 截图重生成（发行前） | `node scripts/capture-guide-shots.js`（UI 改动后跑一次即可） | 管线脚本 |

---

**结论**：P6 完成，停在 P6，不进入 P7。
