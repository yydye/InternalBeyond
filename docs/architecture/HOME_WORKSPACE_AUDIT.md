# Home Workspace Audit

审计日期：2026-09-28。P37 开始于 `master` / `ca98a4ea42a9aa90180d6c942d1da71d966a711c`；当时工作区已有 56 个 tracked 修改与 443 个 untracked 文件。本审计只读检查现有页面与公开读面。

## 1. Original routable Welcome page at P37 start

本节记录的是 P37 改动前的基线。`InternalBeyond.html` 的 `#page-home` 只包含 `.home-content`、品牌标题、tagline 和设计署名；没有 workspace status、recent items 或 quick access。`assets/css/core/pages.css` 为它设置全屏英雄区；`assets/js/core.js` 的 `enterSite()` / `navTo('home')` 通过 `home-title`、`home-subtitle` 和 `home-credit` 做入口动画。

现有 `#nav-home` 是返回该品牌页的按钮，也是 Tauri 隐藏点击手势目标。它的技术 ID 和 `navTo('home')` 行为需要保留。

## 2. Existing Data Sources

| 信息 | 已有来源 | 只读边界 |
|---|---|---|
| Chat topic/thread metadata | IndexedDB `chatThreads`；记录由现有 `app-store.js` / `activity-runtime.js` 写入，含 id、friendId、name、created 等 metadata | Home 可用 `dbScan()` 对该 store 做有界扫描并只投影标题/时间/type；不读 `chatMessages`，不读 `chatSummaries.summary` |
| Chat message content | `chatMessages`，经 `dbGet*` / Home Node 接缝管理 | 每条记录包含正文与私密字段；Home 不查询、不扫描、不展示 |
| Recent Activity | 现有 `IB.activity.listActivities()` | 该 API 内部 `dbGetAll('activities')` 并返回整条 Activity；Home 不用它。改用现有 `dbScan()` 有界读，并只保留 id/title/type/updatedAt |
| Memory summary | 现有 `_ibCount('memories')` | 只取 IndexedDB store count；不调用 `updateMemDashboard()`，后者会 `dbGetAll('memories')` 并遍历正文/visibility |
| Local storage availability | `dbScan()` 是 Core 已有只读 cursor API，先经 `ensureDB()`，事务失败会 reject | Home 只做一次 `chatThreads` store 的一条上限 readiness probe，不新增 status store |
| Packaging availability | P35.6 同源 API `GET /__packaging/jobs` 返回 `available` 与进程内 session list；只读，不运行 preflight/build | Home 只取 available boolean，不消费 job result；不可用时显示 Unavailable |
| Voice | Voice controls/materialization 属于通信与 Chat UI；没有独立 Voice status facade | Home 显示入口位置/导航，不探测凭据或调用 Voice provider |

`dbScan(store, visitor, {direction, maxRecords})` 在现有 Core 中逐条同步调用 visitor、达到上限即停止，不将整个 store `getAll()` 到内存。`_ibCount()` 只调用 object store count。Home 不会调用 `dbGetAll('chatMessages')`、`dbGetAll('memories')`、`IB.activity.listActivities()` 或 `updateMemDashboard()`。

## 3. Existing Quick Access and Duplication

当前没有独立 Home quick-access component。导航由 P36 Sidebar Shell 提供，并通过既有 `navTo(page)` 进入页面；Home 快捷项应只委托此路由，不复制业务操作。

Memory 页面已有完整 dashboard 与 token 估算，但它遍历 Memory 内容，不适合作为 Home 状态聚合器。Activity 的公开 list API 会物化整个 store，也不适合作为 Home 的 recent source。P37 将只新增 Home 侧的安全投影，不复制上述模块逻辑。

## 4. Safe Home Workspace Contract

Home 聚合公开摘要并跳转页面。数据读取独立失败，不阻止空壳、品牌区、快捷入口或其他来源渲染。Recent 项仅显示标题、时间和类型，最多显示少量条目；最近聊天只来自 bounded thread metadata，因此没有 thread row 的普通默认聊天不会出现在 Recent。所有动态文本以 `textContent` 渲染。

Home 不访问 API 配置对象、API Key、Vault、Credential API、聊天正文、Memory 内容，不调用模型、Chat sender、Packaging executor 或任何写入 API。没有安全公开的 current-role/status facade，因此不显示推断出来的 active role/provider/mode。

## 5. P37-FIX ownership map

| Surface | User-visible role | Route | DOM root | Owner |
|---|---|---|---|---|
| Launch Welcome overlay | 首次进入时显示的介绍层；不属于 sidebar page route | `enterSite()` controls visibility | `#splash` | Existing Welcome behavior |
| Welcome / Landing | 原 IB 品牌欢迎页 | `#home` → `navTo('home')` | `#page-home` | Original `home-content` and entrance animation |
| Home Workspace | Sidebar 中的 Home 产品入口 | `#workspace` → `navTo('workspace')` | `#page-workspace` | P37 dashboard and lazy, read-only aggregation |
| Active | Existing work page | `#active` → `navTo('active')` | `#page-active` | Existing Active module |

`#nav-home` remains the legacy brand control for Welcome and retains the Tauri gesture target. The new Sidebar Home route has a separate link and page identity. P37 aggregation is triggered only when `#page-workspace` becomes active; it does not run while Welcome or another page is active.
