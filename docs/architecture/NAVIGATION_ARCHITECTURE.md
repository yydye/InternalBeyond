# Navigation Architecture

状态：P36 Workspace Sidebar Shell 已实现；P37 为 Sidebar Home 增加独立 Workspace 页面路由。此文记录页面入口组织与 shell 边界；业务页面、router、存储和 service contract 仍由各自模块持有。

## 1. Why Sidebar

原有顶部导航把 18 个静态入口放在同一条横向列表里；Room 还会在运行时由 `game/game_module.js` 插到 Chat 之前。随着页面增加，导航条在常见桌面宽度下会横向滚动，末尾入口会被右侧 Export/Import 操作区挤到视口之外。P36 将这些入口放入固定、可折叠的工作区侧栏，内容区按侧栏宽度调整。

## 2. Navigation Inventory

| 页面或能力 | 现有入口 / 路由 | 入口性质 |
|---|---|---|
| Room | `#game` → `page-game` | `game/game_module.js` 注入的现有入口，插在 Chat 之前；shell 为其补齐图标字母/标签包装 |
| Chat | `#chat` → `page-chat` | 主页面 |
| Profile | `#about` → `page-about` | 个人资料页 |
| Memory | `#memory` → `page-memory` | 主页面 |
| Favorites | `#favorites` → `page-favorites` | 主页面 |
| Blog | `#blog` → `page-blog` | 主页面 |
| Moments | `#moments` → `page-moments` | 主页面；设置子页面为 `page-moments-settings` |
| Letters | `#letters` → `page-letters` | 主页面 |
| Role DM | `#roledm` → `page-roledm` | 主页面 |
| Diary | `#diary` → `page-diary` | 主页面 |
| Active | `#active` → `page-active` | 主页面；承载后台计划和自动化能力 |
| DIY | `#diy` → `page-diy` | 主页面 |
| Apps | `#apps` → `page-apps` | 主页面；Cinema 等应用由 App Store 管理 |
| Economy | `#economy` → `page-economy` | 主页面 |
| Packaging | `#packaging` → `page-packaging` | P35.6 页面 |
| API | `#api` → `page-api` | API 与 Middle Brain 配置页 |
| Bridge | `#bridge` | 特殊 modal action；没有 `page-bridge` |
| Diagnostics | `#diagnostics` → `page-diagnostics` | 主页面，由 Diagnostics renderer 填充 |
| Guide | `#guide` → `page-guide` | 帮助页面 |
| Welcome / Landing | `#home` → `page-home` | 原品牌欢迎页；既有 `#nav-home` 品牌按钮调用 `navTo('home')` |
| Home Workspace | `#workspace` → `page-workspace` | Sidebar Home 入口；承载 P37 Personal Workspace、Recent、Quick Access、Workspace Status |

页面集合还包含 `page-coread`；它是已有功能内的上下文页面，并非之前顶部导航的独立入口。P36 不额外提升其层级。Voice 和 Calendar 仍是现有聊天/浮动组件，没有对应的顶层 `page-*` 路由。

## 3. Information Architecture and Groups

侧栏将原有入口分组，不增加路由：

| Group | Entries |
|---|---|
| Core | Home、Chat、Room、Profile、Memory、Favorites |
| Create & Connect | Blog、Moments、Letters、Role DM、Diary |
| Work | Active、DIY、Apps、Economy |
| Tools | Packaging、API、Bridge、Diagnostics |
| Help | Guide |

没有独立 Characters、Middle Brain、Cinema、Voice、Calendar、Work Mode 或 Settings 页面。Characters 属于 Chat；Middle Brain 普通配置位于 API 页；Cinema 属于 Apps；Voice 属于通信能力；Calendar 是浮动日历；当前没有独立的通用 Settings route。分组不会把这些能力伪装成新页面。

## 4. Sidebar Shell and Component Boundary

`InternalBeyond.html` 保留 `nav id="navbar"`、`.nav-brand`、`.nav-links` 和 `.nav-actions`，并在同一 `.nav-links` 列表内添加分组标题。P37 将一个 `data-page="workspace"` Home 入口放入 Core；对应页面仍由既有 `navTo()` 分发。`assets/js/navigation-shell.js` 只处理展开/折叠状态、aria 属性、响应宽度和偏好持久化；它不选择页面、不载入业务数据、不调用业务 module。

Expanded 模式显示原有标签。Collapsed 模式保留首字母标记、原生 `title` tooltip、键盘焦点和 accessible label。用户偏好使用 `localStorage` key `ib_navigation_collapsed_v1`；没有显式偏好时，1120px 及以下默认折叠。没有新增数据库或 storage contract。

## 5. Visual Language Reuse

导航继续使用 IB 的 `--glass-bg-elevated`、`--glass-border-strong`、surface/text/status tokens、Noto Sans SC、Cormorant Garamond、现有按钮、阴影、focus ring 和 motion scale。新样式只布局 sidebar shell 和局部 nav row；不新增 UI framework、icon package 或颜色 token。折叠标记采用文字首字母，不新增图标库。

## 6. Route Compatibility

`assets/js/core.js` 的 `navTo(page)` 仍是唯一页面切换器：它切换原 `page-*` 节点、更新 `.active` / `aria-current`、执行原来的按页初始化，并同步 hash。Hash restore、浏览器前进/后退、页面 ID 和各页面 lazy initialization 均保留。P36 没有重写 router 或改任何页面 ID。

- `#Beyond` / `#beyond` 仍由 `secret-routes.js` 解析。`nav-home` 的现有 ID 与点击目标保留，因此 Tauri 的隐藏点击手势继续绑定。
- `?middlebrain`、`?middlebrain=1`、`?middlebrain=true` 仍由 Middle Brain Direct Channel 处理；`?middlebrain=0` 仍不打开它。该 query route 不出现在 sidebar。
- `#nav-home` 是 DOM element id，不是 hash route；点击仍通过 `navTo('home')` 返回 `page-home` Welcome / Landing。Sidebar Home 使用 `#workspace` 并打开 `page-workspace`。
- `navTo()` 依据真实页面 route 更新 `.active` 与 `aria-current`：Welcome 不高亮 Sidebar Home，Home Workspace 高亮 Home，Active 高亮 Active。
- Bridge 链接仍保留 `ib-bridge-nav` ID、dialog attributes 和原 modal click handler；它不会传入 `navTo('bridge')`。
- Tauri 继续加载 `InternalBeyond.html?ib_tauri_host=1`。Rust command 和 `tauri.conf.json` 未改。`tauri-window-chrome.js` 将拖动区从旧横向导航空隙移到主内容上方独立标题条，最小化/最大化/关闭仍调用原 Window API。

## 7. Future Extension Rules

新增一级入口前，先确认存在稳定的页面 ID / route，选择一个真实职责分组，并更新结构测试与本导航清单。嵌入式能力、modal、query secret route 不应只为填满侧栏而变成普通页面。未来折叠/分组调整只可改变 shell 展示，不可自行更改 router 或 service authority。

> Welcome and Home are separate product surfaces even if legacy DOM IDs or historical navigation identifiers use ambiguous names. Sidebar changes navigation architecture only; existing page content remains independently owned by its original module.
