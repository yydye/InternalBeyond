# Project-IB 全局 UI 视觉迁移审计

日期：2026-09-28
状态：只读审计完成，等待用户确认迁移顺序（未修改任何生产代码）
基线：`master` @ `ca98a4e`；工作区含 57 个 tracked 修改 + P35.6/P36/P37 等 untracked 新增
视觉权威：`internal-beyond-design` skill（最高）· Hallmark（AI-slop 审计）· 本报告全部结论均带 source 证据

---

## 1. 全局 UI Inventory

### 1.1 Desktop 页面（InternalBeyond.html，3753 行，400 KB）

| Page id | 行范围 | 首屏结构 | 开场形态 | 归属 CSS | 密度 | 状态 |
|---|---|---|---|---|---|---|
| page-home | 187–193 | `.home-content` 品牌 hero | 全屏 Hero（`min-height:calc(100vh-120px)`, pages.css:162） | core/pages.css | calm | 原样保留 |
| page-workspace | 195–276 | hero + 2 面板 + status | Hero + "Welcome back" 问候（L205） | home-workspace.css（新） | standard | P37 未提交 |
| page-blog | 278–348 | `module-intro` + 列表/详情 | module-intro（L280） | core/blog.css | standard | 旧 |
| page-chat | 351–427 | `module-intro` + `.chat-full` | module-intro（L353） | core/chat-shell.css + chat.css | standard→dense | 旧 |
| page-letters | 429–455 | `module-intro` | module-intro（L430） | core/letters.css | calm | 旧 |
| page-roledm | 457–512 | `module-intro`（角色私信） | module-intro（L458） | core/role-dm.css | standard | 旧 |
| page-memory | 514–629 | `module-intro` + 星图 + 卡片 | module-intro（L515） | core/memory.css（最大文件 747 行） | calm→standard | 旧 |
| page-active | 804–1050 | `module-intro` + active-card | module-intro（L805） | core/archive-active.css | standard | 旧 |
| page-diary | 1052–1136 | `module-intro` | module-intro（L1054） | core/archive-active.css（复用） | standard | 旧 |
| page-moments | 1138–1279 | 社交壳 `net-sitebar` | 无 module-intro | moments.css + social.css + social.js | standard | 旧（JS 有未提交改动） |
| page-moments-settings | 1281–1367 | net-sitebar + module-intro | module-intro（L1288） | moments.css | dense | 旧 |
| page-api | 1369–2129 | `module-intro` + `.api-section` 堆叠 | module-intro（L1370） | core/api-components.css + core.css(mb-*) | dense | 旧（JS 有未提交改动） |
| page-guide | 2130–2501 | `guide-header` 居中衬线大标题 | Hero 式（L2132，Guide 属允许语境） | core/pages.css + guide-beginner.css | calm | 旧 |
| page-diy | 2505–2604 | `module-intro` + 4×`.api-section.glass-card` | module-intro（L2506） | core.css + core/workspace.css | standard | 旧 |
| page-about | 2606–2609 | 挂载点（JS 渲染） | JS 渲染 | core/about.css（35 处 backdrop-filter） | standard | 旧 |
| page-apps | 2610–2614 | `.plate`（App Store 网格） | plate-title | app-store.js（JS 注入） | standard | 旧 |
| page-favorites | 2616–2620 | `.plate`（fav-wall） | plate-title | favorites.js（JS 注入） | standard | 旧 |
| page-diagnostics | 2622 | 空页（JS 渲染） | 无 | diagnostics.css（干净，0 raw） | dense | 旧（JS 未提交改动） |
| page-packaging | 2626–2714 | `pc-shell` + 状态面板 | pc-page-heading（L2630） | packaging-center.css（新） | dense | P35.6 未提交 |
| page-economy | 2721 | JS 渲染容器 | 无 | economy-shell.css + economy-*.css | dense | 旧 |
| page-coread | 2723–2743 | `.plate` 阅读器 | plate-title | core/archive-active.css | calm | 旧 |

### 1.2 Overlays / 浮动层 / dialogs

| 表面 | 实现 | 归属 |
|---|---|---|
| Splash / Welcome 首启层 | `#splash` + splash-mist-canvas（内联 SVG/画板） | core.css L202+ |
| Bridge modal | `#ib-bridge-panel` dialog | bridge.css |
| 群聊 dialog | `.group-dialog`（340px 固定宽，自成一派） | core/widgets.css:181+ |
| 凭据 modal | `.ib-cred-modal-*` | core.css L360+（未提交新增） |
| Update card | `#page-update` / update-card.js（JS 注入 style） | update-card.css |
| Setup wizard | setup-wizard.js（3 处 JS 注入 style） | setup-wizard.css |
| Voice call 覆盖层 | voice-call.css（24 hex / 12 raw bg） | voice-call.css |
| Calendar 浮窗 | calendar.css（87 gradient / 14 blur / 37 小字号） | calendar.css（允许动态加载） |
| Easter egg（Basement/Lock） | core.css L519–571（紫色系，刻意例外） | core.css |
| 记忆清理 modal | `.mem-clean-*`（modal 内再放 rgba(14,20,36,.5) 小卡片） | core.css L660+ |

### 1.3 组件级公共件

- `module-intro`（每页开场条，api-components.css:80 定义，backdrop-filter blur(6px) + rgba 填充）— 出现在 blog/chat/letters/roledm/memory/active/diary/moments-settings/api/diy 共 10 页。
- `glass-card`（core.css + 各模块覆盖）为事实上的万能卡片类。
- JS 注入 style 的文件 12 个：setup-wizard(3)、guide-beginner(2)、economy-shell(2)、update-card(2)、role-dm-ui(2)、economy-configuration(2)、api-onboarding(2)、diagnostics(2)、economy-approval(2)、integrations、backend-restart、easteregg。

### 1.4 Mobile（Android Compose，`android/.../ui/`）

| 区域 | 文件 | 结论 |
|---|---|---|
| 主题 | IbColors/IbTypography/IbShapes/IbSpacing/IbTheme | 深夜蓝 #0F1424/#181E32/#263050，冰蓝强调 #5080B0/#72A8D8；serif display + sans body + mono；玻璃=α 填充+1dp 描边（无 blur）；圆角 28/16/12/10；间距 4–40，触控 48dp |
| 主要屏幕 | CharacterList / Chat / Pairing / Settings | 单一主表面、topbar+底部 sheet；无 dock；IbTextAction ≈35dp（低于 44） |
| 主题模式 | 仅深色（darkColorScheme），无 Internal/Infernal 切换 | 与"双主题 DNA"存在产品级差异 |
| 环境光 | GlowIndigo #3B4A8C / GlowViolet #5B4FA8 radial 光 | 紫蓝光晕，偏离冰蓝调 |

### 1.5 资源规模（实测）

CSS 34 个文件。反模式指标 Top（计数=规则数）：chat.css 94 raw-bg/25 小字号/13 大圆角/16 blur；memory.css 94 raw-bg/39 blur（全站最高）/139 gradient；calendar.css 75 raw-bg/37 小字号/87 gradient；workspace.css 83 raw-bg；widgets.css 77 raw-bg/26 blur；blog.css 52 raw-bg/28 blur；about.css 35 blur；小字号合计 ≈120+ 处。

---

## 2. 当前视觉问题与 AI-SaaS debt（按严重度）

### Critical

1. **首页即全屏品牌 Hero + 每页 module-intro 开场** — `#page-home` 全屏（pages.css:162）；10 个模块页继续用带 blur 的 `module-intro` 开场条（api-components.css:80-89）。Skill 规则：hero 仅限 splash/guide/character/narrative；module page 必须以 work 开场。这是"巨大 Hero / Welcome 标题"的直接来源。
2. **P37 Workspace 复用品牌 Hero + ChatGPT 式问候** — `home-workspace-hero` 完整复用 home-title/home-subtitle/home-credit（HTML L197-209），"Welcome back / Your space on this device / A quiet place for conversations" 是典型 SaaS greeter；与 skill 的 workspace 组成（presence → work → recent → status）不符。
3. **紫蓝 AI 色残留（网络扫描仅 4 处）** — core.css `mb-adv-card`(L584)、`mb-model-active`(L601)、`mb-tick-active`(L615) 使用 rgba(120,140,255,…)；`mb-speed-btn`(L623) 使用 **#a855f7 紫 + rgba(168,85,247)**。Android `GlowIndigo/GlowViolet`（IbColors.kt:110-111）。其余"紫蓝渐变感"主要来自全站蓝白玻璃叠在蓝照片上，而非真紫色值。
4. **玻璃滥用与多层套叠** — 全站 backdrop-filter 约 180+ 处；嵌套 Glass 实例：`.api-section.glass-card` > `.mb-adv-card`/`.mb-collapse-head`；`.mem-clean-modal`(glass) > `.mem-clean-item`(rgba 小卡)；`.ib-cred-modal` > 输入/按钮条。Skill 限制最多 2 层玻璃、内层须去边框或降为 ambient。
5. **模块各自发明语言** — 12 个 JS 注入 style；34 个 CSS 各自定义按钮/输入/卡片；模块私有 token 前缀 --esh/--eph/--gw/--am/--roledm 颜色未全部走语义 token（economy-shell.css 13 raw-bg）。且 `memory.css` 内含 `#page-chat` 气泡规则（所有权越界，见 memory.css:33-70）。
6. **内联样式预算超限** — test_frontend_structure 实测 static=219（预算 200）、total=487（预算 470），两项 FAIL（与本次未提交改动无关，HEAD 同为 219；属历史债）。

### Major

7. **超大圆角与固定尺寸** — chat.css:2 与 widgets.css:2 的 28px 容器圆角、chat.css:184 24px、memory.css:299 24px、calendar 21/22px；另有大量 999px pill。Skill：control 10 / card 12 / panel 16。
8. **小字号密集** — calendar 37 处、chat 25 处、memory 17 处、workspace 14 处低于 `--fs-meta`(0.74rem)；最小 0.48rem（calendar.css:268/447）。密度契约禁止以缩字换密度。
9. **巨量留白冒充高级感** — `.page` 统一 `padding:90px 32px 80px`（memory.css:4）；splash-left 左侧 clamp(100–210px) 边距；部分页面 max-width 900px 导致大屏空置。
10. **raw rgba 大面积覆盖** — chat/memory/workspace/widgets/blog/calendar 合计 475+ 处 `background:rgba(`，其中 #page-chat 浅色模式还叠加 'text-shadow 白色发光' 补丁（core.css L420-424）——用发光补对比度的反模式。
11. **卡片墙** — Favorites `.fav-wall`、Apps `.appstore-grid`、Memory `.mem-dash`(4 列统计卡)、Workspace 2 面板 + 4 status 卡、Packaging 结果网格——布局可读但仍是"卡片阵列"叙事。
12. **交互一致性** — 群聊 dialog 固定 340px、自带 --bg-mid 背景（widgets.css:181）不随玻璃 ladder；update-card/setup-wizard 注入样式自成体系。

### Minor

13. Easter egg（Basement/Lock）紫色系与主调不一致——但属刻意隐藏彩蛋，建议保留、不纳入迁移。
14. 文案中英混排（"Welcome back"/"Your space..."）与 IB 双语诗性规则（大写标签+中文句）不符。
15. 仓库杂项：根目录遗留 `deleted-backup-audit.json`、`hibit-identity-transition-report.json` 等与 `tmp/`，迁移提交前需清理。

---

## 3. Semantic Surface / Token 使用情况

权威层：`core.css`。已具备完整 L2 token：`--surface-*`、`--glass-bg-{ambient,surface,elevated,floating,modal}`、`--glass-filter-{sm,md,lg,xl}`、`--content-*`、`--border-*`、`--radius-*`、`--shadow-*`、`--motion-*`、`--space-*`、`--fs-*`、`--font-*`、`--status-*`、`--layer-*`、`--focus-ring`、neo 控件深度。
未提交改动新增：`--space-8`、`--fs-meta/body/h3/h2`（core.css，方向正确）。

| 状态 | 模块 | 证据 |
|---|---|---|
| 合规（基本只用语义 token） | home-workspace、navigation-shell、packaging-center、moments、diagnostics、local-*、api-onboarding、guide-beginner、setup-wizard、bridge | 各文件 raw-bg ≤2，hex ≤3 |
| 半合规（几何用私有 token/颜色多数走 token，仍有 raw） | economy-shell/configuration/approval、social、role-dm、activity、letters、pages、middle-brain-direct、chat-shell | raw-bg 5–27 |
| 待迁移（大量 raw rgba/hex 自成一派） | core/chat、core/memory、core/workspace、core/widgets、core/blog、core/about、calendar、voice-call | raw-bg 52–94，blur 16–39 |

其他事实：
- JS 侧无统一 token 层——12 个文件用字符串拼 style；`social.js` 未提交 diff 仅新增 1 处行内 `style="cursor:grab;gap:12px"`。
- `test_frontend_structure.js` 已有 token 断言（core.css 必含 --surface-* 等）与内联预算，是迁移可用的回归底座。
- 编码约束：所有 `assets/css|js`、`game`、`InternalBeyond.html` 必须有 UTF-8 BOM 且 HTML <500 KiB、无 `<style>` 块——当前 22 项结构测试 FAIL（详见 §8）。

---

## 4. calm / standard / dense 密度分布

| 密度 | 页面/表面 | 当前实测 | 契约要求 |
|---|---|---|---|
| calm | Guide、Letters、Memory 浏览、Coread、Splash、角色 Moments | Guide 908px 轨道 ✅；Letters 单列 ✅ | 单列 ≤720–880px，行高 1.7–1.9 ✅ |
| standard | Blog、Chat、Moments、Diary、Favorites、Apps、Workspace home、RoleDM | 多数 2–3 列 ✅；Workspace 1160px 网格 ✅ | 40–44px 行、meta ≥ --fs-meta ⚠️（chat 25 处小字号） |
| dense | API/Middle Brain、Diagnostics、Economy、Packaging、Active、Calendar、Moments-settings | API 86 内联样式；Calendar 37 处 <0.74rem ❌ | 32–40px 行、meta 用 --fs-meta、tabular-nums；禁止缩字号 |

结论：分布方向正确，问题集中在 (a) standard 层聊天/记忆偏小字号，(b) dense 层 calendar/api 的缩字与重复样式，(c) calm 层 Memory 星图/图表用 raw 色。

---

## 5. Desktop / Mobile 分别如何迁移

### Desktop（保留 P36 左轨，统一为唯一导航实现）

1. **导航层收敛**：`navigation-shell.css` 与 core.css 旧顶栏规则（L298–414）当前是"两套定义 + 覆盖"关系；core.css 必须退化为 token 与旧行为兼容层，导航几何只保留 navigation-shell.css 一处（260/76px、elevated、hairline）。
2. **pageChrome 统一**：把 10 页的 `module-intro` 收敛为 `surface.pageChrome`（透明或 --surface-panel + 底部 hairline、无 blur、无独立渐变），标题用 --fs-h2/h3 + caps 标签（Raleway 0.08–0.24em）。
3. **Hero 政策**：`#page-home` 属 splash/ceremonial 语境可保留（不删，它是 DNA 入口）；Workspace 头改为紧凑 presence 行（角色/状态/一句中文），删除重复的 home-title 堆叠与英文 greeter；Quick/Recent/Status 保留。
4. **逐模块 token 迁移**：chat/memory/widgets/blog/about/calendar/voice-call 按 §6 阶段把 raw rgba → 最近 glass ladder/surface 档；`--surface-chat-bubble-*` 按 skill 建议在 chat 迁移时新增。
5. **半径与字号归一**：容器 ≥20px 半径收敛到 16（panel）/12（card）/10（control）；所有 <0.74rem 提到 --fs-meta 或删除；减少 90px 统一 padding。
6. **内联样式预算**：以 static ≤200 / total ≤470 为迁移验收线，P37 已证明可零新增。

### Mobile（Android 保持自有语言，只做 DNA 校准）

1. **主题决策点**：目前仅 Infernal 夜态。二选一：实现 Internal 雾光浅色版，或正式声明 mobile=Infernal-only 并写入契约文档（需用户拍板，不建议机械移植桌面双主题）。
2. **环境光去紫**：GlowIndigo/GlowViolet → 冰蓝 #5080B0/#72A8D8 系。
3. **触控**：IbTextAction 补 minHeight 48dp；其余已达标。
4. **标签体系**：增加 letter-spacing caps 标签以与桌面同源；serif+sans 分工已正确。
5. **Dock 决策**：当前 backstack 路由无底栏；按契约 topbar+dock+sheet 三件套补齐 dock（3–5 项）或在契约中显式豁免。

---

## 6. 推荐全局迁移顺序（低风险高杠杆优先）

| 阶段 | 内容 | 涉及文件（主） | 风险 |
|---|---|---|---|
| P0 冻结与卫生 | BOM 修复（packaging-center.*、core.js、home-node-client.js 等 19 项中的新增/改动子集）；记录 22 项测试 FAIL 基线；KPI 计数器（raw-bg/小字号/大圆角/内联）脚本化 | tests/test_frontend_structure.js、相关 css/js | 低（纯修复） |
| P1 Shell 收敛 | 导航单源化（core.css 顶栏规则退役为兼容层）；pageChrome 统一；mb-* 紫色→token；cred modal raw 色→glass token；titlebar 对齐 | core.css、navigation-shell.css、api-components.css、InternalBeyond.html | 中（全站可见，需双主题+1120/760px 截图） |
| P2 Home | Workspace header 去 hero/去 greeter；Home 与 splash 关系定案；Recent/Quick/Status 精修 | home-workspace.css/js、InternalBeyond.html、core/pages.css | 中（首屏，含 P37 未提交代码整合） |
| P3 Chat 群聊 Voice | 气泡 token 化（--surface-chat-bubble-*）；从 memory.css 迁出 chat 规则；group-dialog→dialog token；voice-call→overlay token；thinking 块扁平化 | core/chat.css、core/chat-shell.css、core/memory.css、core/widgets.css、voice-call.css、core.css | 高（聊天主路径 + 浅色发光补丁拆除） |
| P4 创作与连接 | blog/letters/moments/social/favorites/coread 的 raw→token、圆角/字号归一、卡片墙弱化（hairline 分组） | core/blog.css、core/letters.css、moments.css、social.css、core/archive-active.css、social.js | 中 |
| P5 Memory + 浮窗 | mem-* 图表/星图配色入 token；calendar 87 gradient 审计（保留天文视觉但去冗余）；widgets 玻璃降层 | core/memory.css、calendar.css、core/widgets.css、memory-sky.js | 中（数据可视化需保真） |
| P6 系统密集区 | api/middle-brain/diagnostics/economy/packaging/setup-wizard/update-card/bridge 的 raw→token、tabular-nums、JS 注入样式收敛 | core.css(mb-*)、core/api-components.css、economy-*.css、diagnostics.css、setup-wizard.css、update-card.css、bridge.css、setup-wizard.js 等 12 个注入文件 | 中高（功能页，需逐页冒烟） |
| P7 Mobile 校准 | 主题决策、去紫环境光、48dp、标签体系、dock 决策 | android/.../ui/theme/*、common/*、IbRoot.kt | 中（独立构建链） |
| P8 护栏 | 反模式 lint：新 css 禁 raw hex/rgba（core.css 除外）、容器半径上限、字号下限、BOM 强制；design 文档与 skill 对齐 | tests/*、docs/architecture/* | 低 |

依赖：P0→P1→P2 串行；P3 与 P4 可并行（文件不相交）；P5 与 P6 可并行；P7 独立；P8 最后。

---

## 7. 每阶段文件与风险（补充）

- **P1 最大风险**：core.css 同时承载旧顶栏 + 浅色主题补丁（L419–511 大量 `body:not(.theme-infernal) .page.active ...` 逐元素压色规则）。退役时必须在深浅两主题下逐页验证，否则浅色可读性回退。建议先建"视觉回归截图清单"（21 页 × 2 主题 × 1280/900px）。
- **P3 最大风险**：拆白色 text-shadow 补丁会暴露对比度不足；必须同时把底色提到 surface 档或加深字色，逐步拆。
- **P5 风险**：memory 星图与 calendar 的天文/天气视觉属于数据可视化，不应被判为 slop 而削平；只允许去重复与配色 token 化。
- **P6 风险**：JS 注入样式分散在 12 个文件，需按文件对照 diff 逐处替换，避免行为回归；`imageRouterSettings.statesCredentialOrigin` 等测试断言涉及文案，改动前先跑 `tests/test_frontend_structure.js` 与相关 smoke。
- **通用风险**：`InternalBeyond.html` 已达 400 KB（上限 500 KiB），P2/P6 若继续内联增长会触顶；新表面一律走独立 CSS。
- **证据基线**：本审计的量化命令（gradient/blur/raw/small-font/radius/内联计数）可作为 P0–P8 的可复核 KPI。

---

## 8. 未提交 UI 改动与新方向的关系

### 8.1 结论

**大部分对齐，无需回退；两处需要调整，一处需要修复。**

| 改动 | 判定 | 说明 |
|---|---|---|
| P36 `navigation-shell.css/js` + HTML 侧栏标记 | ✅ 对齐 | 左轨 260/76 即 skill 的 desktop surface.navigation 契约；仅需在 P1 收敛 core.css 旧顶栏定义，避免双源 |
| P37 `home-workspace.css/js` + HTML | ⚠️ 需调整 | 结构（recent/quick/status）符合 workspace 组成；但 header 复刻品牌 Hero + "Welcome back" 英文问候 + `home-recent` 自写白色渐变（home-workspace.css:156-168）与 surface token 不一致 → 归入 P2 重构，不推翻 |
| P35.6 `packaging-center.css/js` | ✅ 对齐（有缺陷） | 系统页 dense、token 化良好；**两个新文件缺 UTF-8 BOM，当前测试 FAIL** → P0 修复 |
| core.css +28（--space-8/--fs-* + cred modal） | ✅ 对齐（有债务） | token 扩充正确；cred modal 用 rgba(28,34,46,.9) 兜底与 #ff8b8b/#ff5c5c raw 色 → P1 收敛 |
| `social.js` +211（凭据 UX）、api-onboarding/diagnostics/setup-wizard/update-card/voice.js 等 | ✅ 基本对齐 | 行为与文案改动；引入的视觉均走 core.css 类。`update-card/setup-wizard` 本有 JS 注入样式 → P6 一并收敛；social.js 新增 1 处行内 style（预算 +1） |
| 凭据/服务/测试/恢复类修改（active/*、services/*、recovery-*） | ✅ 不冲突 | 非视觉层 |
| 注：`tmp/`、根目录 3 个 JSON 报告 | ⚠️ 卫生 | 迁移提交前清理 |

### 8.2 当前树上的红灯（必须先知晓）

`node tests/test_frontend_structure.js` → **22 项 FAIL**（本次审计实测）：

- **19 × BOM**：含新文件 `packaging-center.css/js`、被修改的 `core.js`/`home-node-client.js`，以及 `economy-shell.css`、recovery-* 等历史文件（部分为恢复工作遗留）。
- **staticInlineBudget 219/200、totalInlineBudget 487/470**：系历史债，工作区与 HEAD 的 HTML 内联计数完全相同（219=219），**P36/P37 未新增任何内联样式**。
- **imageRouterSettings.statesCredentialOrigin**：`image-router-settings.js` 文案断言（"图片服务商 / 图片接口地址 / 图片 API Key"）未满足，属被修改 JS 的文案回归。

迁移工作在任何提交前应先让该测试回到绿（或记录豁免），否则无法区分新旧回归。

---

## 附：审计方法（可复核）

- 结构：`git status/diff --stat`；`yan_analysis_repo_map`；CSS/HTML/JS 文件清单与行数。
- Skill 权威：internal-beyond-design（含 semantic-surfaces、product-adaptation、desktop/mobile-layout、anti-patterns）；Hallmark audit 规则。
- 量化：PowerShell 正则统一统计 34 个 CSS 的 gradient/backdrop-filter/hex/raw-bg/小字号/大圆角/!important；紫蓝 hex 集合扫描（全 assets 仅 4 处命中）；12 个 JS 样式注入文件；HTML 内联计数 HEAD vs 工作区对比。
- 移动端：Android Compose theme/common/screen 13 个文件只读评审（ChatScreen/SettingsScreen 未覆盖，P7 前补读）。
- 测试：`node tests/test_frontend_structure.js`（22 FAIL，明细见 §8.2）。
- 限制：未做浏览器截图验收（本任务要求先审计、不改代码；建议 P0 建立 21 页×2 主题截图基线）；memory/calendar/economy 的逐规则确认留在对应阶段执行。
