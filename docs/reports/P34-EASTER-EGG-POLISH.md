# P34 · Easter Egg Polish / Closure（Phase 2–5）

- 日期：2026-09-26
- 基线：`master`，`HEAD=85f91be`（`85f91bef2f2417cf97917585904a696d58a9c511`）
- 前置审计：`docs/reports/P34-EASTER-EGG-AUDIT.md`（Phase 1，只读）
- 本阶段性质：**未修改任何生产线代码**（`git status` 无新增彩蛋相关改动）。本轮只做审计、验证与收口记录。
- 最终状态：**`P34_EASTER_EGG_AUDIT_ONLY_COMPLETE`**

## Phase 2 — 彩蛋稳定化验证

| 要求 | 验证方式 | 结果 |
| --- | --- | --- |
| 普通启动不显示开发入口 / 调试按钮 / secret menu | CDP `browser.normal.no-secret-ui`：`!document.getElementById('ibterm') && !document.getElementById('ib-middle-brain-direct-root') && !document.getElementById('ib-secret-route-console')` | PASS |
| 彩蛋明确隐藏、不影响导航 | Browser `?middlebrain`/`#Beyond` 关闭后 query / hash / page 不变（`browser.middlebrain.close-query`、`browser.middlebrain.close-hash`、`browser.beyond.close-preserves-hash`、`tauri.middlebrain.close-preserves-page-hash`） | PASS |
| 彩蛋不污染正常状态、不改核心数据 | Resolver 纯函数零副作用（`resolve.zero-handler-side-effects`）；源码不含 `eval/fetch/XMLHttpRequest/localStorage/indexedDB/__TAURI__/child_process/exec/spawn/invoke`（`resolver.no-*` 全绿） | PASS |
| 不绕过 Credential authority | Direct Channel 只经 canonical `IB.middleBrainDirectModelCall`（`assets/js/middle-brain.js:261-266`）→ `middleBrainModelCall` → provider seam；缺凭据 fail-safe，无第二套 adapter | PASS（结构 + `test_middle_brain_direct.js`） |
| 不绕过 Recovery policy / Home Node auth / Active permission | Direct resolver 只读，无 `dbPut/dbDelete`、无角色 tick、无 activity/moments/diary/letter writer（`permission.no-chat-writer-call`、`permission.no-role-tick-call`、`context.read-only-deps`） | PASS |
| 手势 / Console 不新增可见入口 | gesture 仅 `#nav-home`（7 次 / 1800 ms，仅 Tauri）；Console 由 `openConsole()` 懒创建，仅 Tauri 可达 | PASS |

## Phase 3 — Middle Brain 彩蛋体验（只验证，不重构）

现有实现已满足目标，**未做重构**：

| 目标 | 现状 | 证据 |
| --- | --- | --- |
| 独立聊天窗口 / 面板 | 全屏 overlay `#ib-middle-brain-direct-root` | `assets/js/middle-brain-direct.js:874-944` |
| 与普通 Chat 分离 | 独立 transcript `localStorage['ib_middle_brain_direct_v1']`，不写 `chatMessages/chatThreads/chatSummaries` | `assets/js/middle-brain-direct.js:23`；`docs/P31_MIDDLE_BRAIN_DIRECT_CHANNEL.md:50` |
| 保留两套 system prompt | `DIRECT_CHAT_SYSTEM_PROMPT` 与 `MB_SYSTEM_PROMPT` 独立，不互相拼接 | `assets/js/middle-brain-direct.js:48-56`；`send.direct-system-prompt` PASS |
| Astra 读取允许范围内上下文 | bounded 只读 resolver（28 来源 / 7200 字 / 1900 tokens），来源带 provenance | `test_middle_brain_direct.js`：`context.budget-*`、`context.provenance`、`context.read-only-deps` 全绿 |
| UI 有明确“隐藏区域”感觉 | `observer channel established · independent conversation`、`context authority · INTERNALBEYOND`、`write authority · NONE` | `assets/js/middle-brain-direct.js:898,901` |
| 不新增第三套聊天系统 | 只有 role Chat / Role DM 链 + 这一条 Direct Channel；Direct 未接入角色执行链 | `docs/P31_MIDDLE_BRAIN_DIRECT_CHANNEL.md:24-27` |

## Phase 4 — Basement / Beyond 检查

| 检查项 | 结果 | 证据 |
| --- | --- | --- |
| 是否能正常进入 | PASS（书柜 marker → 密码锁 → 阶梯 → 地下室 → INFERNAL BEYOND mode → 返回） | `test_basement_cdp.js`：`book.marker`、`lock.open`、`lock.solvedStair`、`basement.open`、`mode.switched`、`mode.restored` 等 PASS |
| 是否在 production build 存在 | 是 | `scripts/release-manifest.js:39`（整个 `assets` 入 payload）；`assets/js/basement.js`、`easteregg.js`、`middle-brain-direct.js`、`secret-routes.js` 均在 staging |
| 是否依赖开发路径 | 否 | 全部走相对 `assets/...` 路径，与 dev / production 一致；未发现 `localhost` / dev-only 分支 |
| 是否有死链接 | 否 | 无独立“Beyond 页面”；`beyond` 即 `#ibterm` overlay；`ib-beyond-leave` 为纯提示节点 |
| 是否缺少入口 | 否 | Basement 有 Room 书柜 UI 入口；Beyond 有 hash/键盘/Console 入口；Middle Brain 有 `?middlebrain` 入口。**未新增任何入口** |

## Phase 5 — Installer Acceptance

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| 彩蛋资源在 staging | 是 | `tmp/p32-w5-r3b/p5.8.5-report.json`（含 `secret-routes.js`/`easteregg.js`/`basement.js`/`middle-brain-direct.js`/`.css` 的 sha256） |
| 彩蛋资源在 installer payload | 是 | `installer/InternalBeyond.iss:137` `Source: "{#StagingDir}\*" ... recursesubdirs` |
| 彩蛋资源在安装后文件 | 是 | `tmp/p32-w5-r3a/installer.log:455`：`Dest filename: ...\InternalBeyond\assets\js\basement.js` |
| installer acceptance 不依赖彩蛋 | 是 | 普通验收（启动 / 窗口 / 数据 / Credential / Home Node）独立；彩蛋无任何 installer 判据依赖 |

## 测试结果（synthetic / local，无真实 API）

| 命令 | 结果 |
| --- | --- |
| `node tests/test_secret_routes.js` | PASS（33 项：resolve / reject / zero-side-effect / no-forbidden-API） |
| `node tests/test_secret_routes_cdp.js` | PASS（18 项，含 normal / query 变体 / false query / `#Beyond` / console / 恶意拒绝 / handler 复用） |
| `node tests/test_easteregg.js` | PASS（9 项：键盘暗语 / `whoami` / `secret` / `exit` / DevTools open / `#Beyond` / hashchange） |
| `node tests/test_basement_cdp.js` | 主路径 PASS（17 项）；见下方已知 flake |
| `node tests/test_middle_brain_direct.js` | PASS（全部 context / send / route / permission / provider 判据） |
| `node --check assets/js/secret-routes.js assets/js/easteregg.js assets/js/basement.js assets/js/middle-brain-direct.js assets/js/core.js` | OK |
| `node scripts/scripts_check_html.js InternalBeyond.html` | `checked 141 local scripts, 0 failed, 0 remote skipped` |

未使用真实 API：以上 CDP 测试均以 `file://` 加载 `InternalBeyond.html`，Direct Channel 无 provider 时 fail-safe，未发起任何网络请求。

## 已知限制 / 诚实记录

1. **`test_basement_cdp.js` 的 `persist.stairRestored` 是已知时序 flake**（4 次运行中 2 次失败：`FAIL` / `PASS` / `PASS` / `FAIL`）。该用例在 `location.reload()` 后重开 Room，期望阶梯随 `crack` 恢复；`#ib-basement` 与 `mode.*` 等其余 16 项稳定通过。此 flake 在 `docs/history/zero-setup/P1-BUNDLED-NODE-REPORT.md:184` 已有记录（“45 项串行 CDP 运行中的 flake”）。根因假设：`basement.js` 的 `_attached` 单次闩锁在 Room 视口被替换后不重新注入阶梯。**本轮未修改 `basement.js`**，因为该文件受 `tests/test_p11_3x_c_boundary_mutations.js:116-119`（M12）锚定，改动引导轮询行会破坏既有边界变异判据；且用户明确要求最小改动。**记录为已知 quirk，不是 P34 blocker 或缺失依赖**。
2. **installed WebView2 DOM 手势可观测性 DEGRADED（继承自 P32-W.3）**：Host 侧 gateway、resolver、既有 handler 已证明；但安装版 WebView2 未暴露可用 DevTools target，无法在 installed payload 内复核 7 连击 DOM。此为验收观测限制，非缺失依赖（见 `docs/P32-W3-SECRET-ROUTE-BRIDGE.md:134,157,183,187,191`）。

## 收口结论

- 隐藏入口与彩蛋系统由 P31 / P32-W.3 已完整实现并收敛于单一 canonical resolver；普通启动零泄漏，彩蛋不修改用户数据、不发起 provider 调用（无凭据时 fail-safe）、不修改 Vault、不影响正常 Chat。
- 本轮**未新增功能、未修改 Recovery / R3 / Active / Credential / Installer authority**，未重构 Middle Brain Direct Channel，未新增第三套聊天系统。
- 无“入口存在但依赖缺失”的 blocker。
- 最终状态：**`P34_EASTER_EGG_AUDIT_ONLY_COMPLETE`**。
