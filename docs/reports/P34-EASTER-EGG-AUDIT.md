# P34 · Easter Egg / Hidden Entry Audit（Phase 1，只读）

- 审计日期：2026-09-26
- 基线：`master`，`HEAD=85f91be`（`85f91bef2f2417cf97917585904a696d58a9c511`，2026-09-26 07:15:35 +0800）
- 性质：只读审计。本文件不修改任何 `Recovery lifecycle`、`R3-C/R3-D`、`Home Node data migration`、`Credential authority`、`Installer authority`、`Active rearm`，也不修改任何彩蛋实现。
- 结论摘要：隐藏入口与彩蛋系统**已由 P31 / P32-W.3 完整实现并收口**，存在唯一 canonical resolver，普通启动零泄漏。本轮无需新增代码。

## 1. 审计检索面

已按指令检索 `easterEgg / Beyond / middlebrain / basement / secret route / hash route / query parameter / console alias / gesture / hidden UI`，并确认以下实现文件：

| 子系统 | 文件 |
| --- | --- |
| Canonical Secret Route Resolver + Tauri Hidden Console + 7 连击 gesture | `assets/js/secret-routes.js` |
| Terminal（Beyond）彩蛋 | `assets/js/easteregg.js` |
| The Basement / INFERNAL BEYOND（UI 彩蛋） | `assets/js/basement.js` |
| Middle Brain Direct Channel（`?middlebrain`） | `assets/js/middle-brain-direct.js` |
| Direct Channel / Hidden Console 样式 | `assets/css/core/middle-brain-direct.css` |
| Host capability seam（Tauri 识别） | `assets/js/host-capability.js` |
| Direct provider seam | `assets/js/middle-brain.js:261-266`、`assets/js/middle-brain-astra.js` |

## 2. 入口清单（Route Inventory）

稳定 route ID 不是 URL 字符串；URL / hash / query / console 只是 adapter 输入。

| Route ID | 触发形式 | Parser（文件:行） | Handler（文件:行） | 当前行为 | 副作用 | 关闭 / 返回 |
| --- | --- | --- | --- | --- | --- | --- |
| `beyond` | `#Beyond` / `#beyond`（遗留 `/beyond/i` 宽匹配）；键盘暗语 `beyond`（1200 ms 窗口，大小写不敏感）；DevTools `IB.easterEgg.open()`；Tauri Console alias `Beyond` / `#Beyond` | `assets/js/secret-routes.js:83-96`；键盘 `assets/js/easteregg.js:154-171` | `IB.easterEgg.open` / `assets/js/easteregg.js:140-152` | 打开假终端叠加层 `#ibterm`，命令 `help/whoami/secret/clear/exit` | 仅 DOM overlay；无 model / network / storage / shell / native invoke | `IB.easterEgg.close()` 隐藏叠加层并原样保留 hash |
| `middlebrain` | `?middlebrain` / `?middlebrain=1` / `?middlebrain=true`；Tauri Console alias `middlebrain` 等 | `assets/js/secret-routes.js:67-81`；`assets/js/middle-brain-direct.js:792-804` | `IB.middleBrainDirect.mount()` / `assets/js/middle-brain-direct.js:874-944` | 挂载独立 Direct Channel overlay `#ib-middle-brain-direct-root` | 独立 Direct transcript + bounded 只读检索；resolver 本身不发 model call | `close()` 用 `replaceState` 仅删除 `middlebrain` query，保留原 hash / page |
| `basement` | Room 书柜交互点 `#ib-bookshelf` → 3 位密码锁 `666` → 阶梯 `#ib-stairs` → 地下室 → `INFERNAL BEYOND` mode | `assets/js/basement.js:58-62,102-128`（UI-only，不是地址栏 route） | `openBasement()` / `activateBeyond()` / `returnToSurface()` `assets/js/basement.js:165-195` | UI 彩蛋：书柜密码锁 + 地下室 + `body.infernal-beyond` | 仅 `localStorage['ib_basement_v2']`（crack/discovered/mode）+ DOM class | 角落返回控件 + `Escape`；`returnToSurface()` 清 mode |

### 2.1 Browser 入口
- `#Beyond`（含遗留 `/beyond/i` 宽匹配）→ Terminal（`InternalBeyond.html` 通过 `assets/js/secret-routes.js` 的 `DOMContentLoaded/hashchange/popstate` 生命周期驱动）。
- `?middlebrain` / `?middlebrain=1` / `?middlebrain=true` → Direct Channel；`?middlebrain=0` 保持隐藏。
- 二者共存时先派发 `middlebrain` 再 `beyond`（`assets/js/secret-routes.js:171-191`）。

### 2.2 Console / DevTools 入口
- `IB.easterEgg.open()` / `.close()` / `.run(cmd)`：`assets/js/easteregg.js:187-188`。
- `IB.secretRoutes.openConsole()`：仅在 `tauriSurface()` 为真时返回 `true`（`assets/js/secret-routes.js:285-298`）。
- Console 精确白名单 alias（`assets/js/secret-routes.js:23-30`）：`beyond`、`#beyond`、`middlebrain`、`?middlebrain`、`?middlebrain=1`、`?middlebrain=true`（输入先 `toLowerCase()`）。未知输入返回固定文案 `Unknown secret route.`，不消失、不派发。
- 恶意输入测试已拒绝：`javascript:`、`file://`、`https://`、`http://127.0.0.1`、`cmd.exe`、`powershell`、路径遍历、`internalbeyond://../../foo`、markup/script、模糊 `midlebran`。

### 2.3 Tauri 入口
- 手势：`#nav-home` logo 上 **7 次点击 / 1800 ms**（`assets/js/secret-routes.js:21-22,300-325`），超时或 `hashchange` 重置；计数只存于闭包内存，不落库。
- 手势绑定要求 `IB.host.platform() === 'tauri'`（`assets/js/secret-routes.js:121-126,318-325`）。加载顺序验证：`host-capability.js` 位于 `InternalBeyond.html:3112`，早于 `secret-routes.js`（`:3325`），因此 boot 时 `IB.host` 已存在，gesture 会正确绑定。
- Hidden Console：`#ib-secret-route-console`，`Escape` / 关闭按钮退出，焦点进入输入框、关闭时回到 logo；无 URL 导航、无 shell、无文件系统、无 native invoke、无 model call。
- 未发现第二条 native hidden route；Tauri 侧只复用上述 resolver 与既有 handler。

### 2.4 UI 入口
- **Basement**：Room 视口内的书柜交互点（`assets/js/basement.js:33-57`），依赖 `G.viewport`；非开发路径依赖。
- **Beyond**：没有独立“Beyond 页面”，`beyond` 即 Terminal overlay（`#ibterm`）。
- **Middle Brain direct UI**：`?middlebrain` 全屏 overlay（`#ib-middle-brain-direct-root`），不创建 `#page-*`、不调用 `navTo()`、不进入普通导航/侧栏。
- **Infernal 提示**：`#ib-beyond-leave`（`InternalBeyond.html:3489`）只在 `infernal-beyond` 模式可见，Direct Channel 打开时被隐藏（`assets/css/core/middle-brain-direct.css:18`）。

### 2.5 边界 / 仅测试用 seam（非用户入口）
- `IB.__mbTrace`（`assets/js/middle-brain.js:365-370`）：dev-only 观测入口，独立于 canonical facade key 契约。
- `root._ibBasement`（`assets/js/basement.js:253-259`）：仅供测试的旁路句柄，不泄露触发条件到可见 UI。
- `/__p32-w3a/acceptance`（`services/internal-beyond-server.js:396-568`）：**默认关闭**的 acceptance seam，必须显式 `IB_ACCEPTANCE_SECRET_ROUTES=1` 且带匹配 `runId` 才可达；普通启动返回 404 / `acceptance-disabled`。

## 3. Production payload / Installer 归属

| 资源 | 入 production payload | 入 installer | 证据 |
| --- | --- | --- | --- |
| `assets/js/secret-routes.js` | 是 | 是 | `scripts/release-manifest.js:39`（整目录 `assets` 入 payload，仅排除 `images/bg-canvas.png`）；`tmp/p32-w5-r3b/p5.8.5-report.json:972` |
| `assets/js/easteregg.js` | 是 | 是 | `tmp/p32-w5-r3b/p5.8.5-report.json:572` |
| `assets/js/basement.js` | 是 | 是 | `tmp/p32-w5-r3b/p5.8.5-report.json:412`；`tmp/p32-w5-r3a/installer.log:455`（`Dest filename: ...\assets\js\basement.js`） |
| `assets/js/middle-brain-direct.js` | 是 | 是 | `tmp/p32-w5-r3b/p5.8.5-report.json:787` |
| `assets/css/core/middle-brain-direct.css` | 是 | 是 | `tmp/p32-w5-r3b/p5.8.5-report.json:182` |
| `installer/InternalBeyond.iss` [Files] | — | 是 | `installer/InternalBeyond.iss:137`：`Source: "{#StagingDir}\*"; ... Flags: ignoreversion recursesubdirs createallsubdirs` |

HTML 载入顺序（`InternalBeyond.html`）：`middle-brain-direct.css:22`、`secret-routes.js:3325`、`basement.js:3326`、`easteregg.js:3327`、`middle-brain-direct.js:3486`（在 `home-node-bootstrap.js:3483` 之后）。

## 4. 已存在入口 / 文件位置 / 当前行为 / payload / installer 汇总

| 入口 | 文件位置 | 当前行为 | production payload | installer |
| --- | --- | --- | --- | --- |
| `#Beyond` / 键盘 `beyond` / `IB.easterEgg.open()` | `assets/js/easteregg.js`、`assets/js/secret-routes.js` | 打开 Terminal overlay；可关闭；hash 原样保留 | 是 | 是 |
| `?middlebrain`（`=1`/`=true`） | `assets/js/middle-brain-direct.js`、`assets/js/secret-routes.js` | 挂载独立 Direct Channel；关闭仅删 query | 是 | 是 |
| Tauri 7 连击 gesture + Hidden Console | `assets/js/secret-routes.js` | 仅 Tauri 生效；白名单 alias；未知/恶意输入拒绝 | 是 | 是 |
| Basement（书柜→666→地下室→INFERNAL BEYOND） | `assets/js/basement.js` | UI 彩蛋；`localStorage['ib_basement_v2']` 持久化；可返回 | 是 | 是 |
| Middle Brain Direct UI | `assets/js/middle-brain-direct.js`、`assets/css/core/middle-brain-direct.css` | 独立面板，两套 system prompt 分离 | 是 | 是 |
| `/__p32-w3a/acceptance` | `services/internal-beyond-server.js` | 默认关闭的验收 seam，非用户入口 | 是（代码），默认不可达 | 是 |
| `IB.__mbTrace` / `_ibBasement` | `assets/js/middle-brain.js`、`assets/js/basement.js` | dev / test-only 句柄，不进入可见 UI | 是 | 是 |

## 5. 只读结论

- 存在**唯一** canonical Secret Route Resolver（`assets/js/secret-routes.js`），Browser 与 Tauri Console 收敛于同一 `dispatch()`；未发现重复的第二套 Middle Brain / Beyond。
- 普通启动（无 query / 无 hash / 非 Tauri）不创建任何 secret UI（CDP 判据 `browser.normal.no-secret-ui` 通过）。
- 彩蛋不绕过 `Credential authority` / `Recovery policy` / `Home Node auth` / `Active permission`：resolver 纯函数、零副作用；Direct Channel 只走 canonical `IB.middleBrainDirectModelCall` → `middle-brain-astra` provider seam（与普通角色同一凭据路径，缺凭据即 fail-safe）。
- 未发现“入口存在但依赖缺失”的 blocker。唯一继承自 P32-W.3 的遗留项是 **installed WebView2 DOM 手势可观测性 DEGRADED**（Host 侧 gateway 被证明，installer 内置 WebView 的 DevTools target 不可用），属验收观测限制，不是缺失依赖。
