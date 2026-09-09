# P5 · System Diagnostics / Self-Recovery 完成报告

阶段目标：普通用户遇到 IB 异常时，不需要打开 DevTools、PowerShell，也不需要知道
Bridge、23115、Node.js 等概念，就能知道"什么功能出了问题、是否影响聊天、能不能一键恢复"。

结论：**P5 完成并通过验收测试，停在 P5，不进入 P6。**

---

## 1. 修改文件

**新增**

| 文件 | 说明 |
| --- | --- |
| `assets/js/diagnostics.js` | 诊断页全部逻辑（能力层状态推导、实时探测、一键检查、一键修复、AI 连接测试、报告导出）。运行时注入自己的样式表，HTML 样式表预算不变 |
| `assets/css/diagnostics.css` | 诊断页样式（复用 `core.css` 既有 token，深/浅主题跟随） |
| `test_diagnostics.js` | 专项契约测试（**120 项全绿**，零网络、零浏览器） |
| `test_diagnostics_smoke.js` | 真实 Chrome smoke（**43 项全绿**，真实静态服务 + 真实 `/__boot-state` + 真实 mock 本地服务） |
| `docs/history/zero-setup/P5-DIAGNOSTICS-REPORT.md` | 本报告 |

**修改（全部为最小改动）**

| 文件 | 改动 |
| --- | --- |
| `InternalBeyond.html` | 3 行：导航 `<li>` 入口、`<div class="page" id="page-diagnostics">` 容器、`<script src="assets/js/diagnostics.js">`。**样式表 20 个、静态内联样式 200 个，与改动前完全一致** |
| `assets/js/error-catalog.js` | 复用既有 `m.action` seam：新增 `open_page` 动作类型（3 行），并给 bridge/active/restart 的 `local_service` 模型挂上「系统诊断」动作。**没有新建第二套错误分类** |
| `test-all.js` | 登记 `test_diagnostics.js`（static）+ `test_diagnostics_smoke.js`（browser） |
| `README.md` | 新增「系统诊断（Diagnostics，普通用户自助）」小节 |

**未触碰**：`middle-brain.js`（并行会话在途）、`assets/js/bridge.js`、`assets/js/local-first.js`、`assets/js/backend-restart.js`、`boot-state.js`、`local-services-runner.js`、`internal-beyond-server.js`、`assets/js/core.js`。

> 说明：导航新增第 15 项后，`diagnostics.css` 用 4 条**作用域限定**的规则
> （`#navbar .nav-links{flex:1 1 auto;min-width:0;overflow-x:auto}` 等）让导航项可横向滚动，
> 避免新增项把右侧操作区压住。实测改动前 1440px 下导航仅剩 21px 余量、1280px 及以下
> 已经溢出；这是既有问题，本次只是不再加剧，未重排全局导航。

---

## 2. Diagnostics 页面结构

独立导航页 `#page-diagnostics`，结构（复用 `module-intro` / `glass-card` / `btn` 等既有类，无内联样式）：

```
系统诊断 · System check
看看有哪些功能正常、哪些需要注意，以及可以怎么处理。
不需要懂技术，也不用打开开发者工具。

[总体标题] 系统运行正常 / 部分功能需要注意 / 部分功能暂时不可用 / 暂时无法确认系统状态
[副标题]   你仍然可以正常聊天。          （仅当聊天可用且存在异常）
最近检查：10:04:57

基础运行        正常          主界面和本地页面服务正常。
AI 聊天         正常          已配置 1 个角色，发送消息时会实时连接。
本地增强功能    不可用        本地增强功能暂时不可用。 可以尝试自动修复。
后台主动功能    正常          后台主动功能正常。 启动时这项功能曾经降级，现在已经恢复。
语音功能        未安装（可选） 还没有配置语音服务，文字聊天不受影响。
视觉功能        未安装（可选） 视觉识别是可选扩展，当前没有安装。

[修复区] 检测到本地功能异常，可以尝试自动恢复。 [尝试修复]
[AI 区]  测试哪个角色 [下拉] [测试 AI 连接]
         测试会实际向 AI 服务发送一个很小的请求（可能产生少量费用）。
[操作栏] [重新检查] [查看技术详情] [导出诊断报告]
[技术详情] 默认收起；展开后才是组件名 / 端口 / Node 版本 / bootId / reason.category / endpoint
```

三个入口（不重排导航）：
1. 导航栏 **Diagnostics**（`<a href="#diagnostics" data-page="diagnostics">`）。
2. **API 设置页**顶部运行时注入的「打开系统诊断」卡片。
3. **P3 本地服务错误卡片**上的「系统诊断」按钮（`IBERR` 的 `open_page` 动作 → `navTo('diagnostics')`）。

接线方式：直接监听导航链接点击 + `hashchange` + 包装 `window.navTo`。
（`core.js` 的导航点击处理器调用的是它 IIFE 内部的 `navTo` 绑定，只包装 `window.navTo` 抓不到导航点击 —— 这是实测发现并修正的问题。）

---

## 3. 用户能力层状态模型

**状态词表（页面唯一来源，六种，不新增第七种）**

| 值 | 显示 | 含义 |
| --- | --- | --- |
| `ok` | 正常 | 该项能力当前可用 |
| `attention` | 需要注意 | 配置不完整 / 被占用 / 上次测试失败，但仍可继续使用其它功能 |
| `down` | 不可用 | 该项能力当前不可用 |
| `optional` | 未安装（可选） | 高级可选组件未安装或未配置，**不是故障** |
| `checking` | 检查中 | 探测进行中 |
| `unknown` | 状态未知 | 无法确认（客户端缺失、探测自身异常、`file://` 打开等） |

**能力层（普通用户视角，顺序即页面顺序）**

| 能力 | 数据来源 | 是否影响总体 |
| --- | --- | --- |
| 基础运行 | 同源 `GET /health`（真实探测）+ boot-state `static` | 是 |
| AI 聊天 | `apiConfigs` 中当前角色的可用性 + 上次 AI 连接测试结果 | 是 |
| 本地增强功能 | `GET <bridge>/health`（身份校验 `IB Bridge`）+ boot-state `bridge` | 是 |
| 后台主动功能 | `_activeCompanionRequest('/health')`（身份 `internal-beyond-active-messages`）+ boot-state `active` | 是 |
| 语音功能 | `<bridge>/status` 的 `tts` / `mimoTts` | **否（可选）** |
| 视觉功能 | `127.0.0.1:<boot-state vision.port>/health` + 安装标记 `.venv-vision/pyvenv.cfg` | **否（可选）** |

总体状态只由**非可选**能力决定：`down > attention > unknown > ok`（有任一项在检查中则先显示"正在检查…"）。
视觉/语音即使不可用也**绝不**让总体变红——smoke 实测：视觉服务未运行时总体仍为「系统运行正常」。

**`probed:false` 不会被渲染成红色故障**：探测不到只落到 `unknown`（"暂时无法检查这项功能。"），
端口被别的程序占用则落到 `attention`（"这项功能被另一个程序占用了。"），两者都不是"故障"。

---

## 4. boot-state 与实时 probe 如何合并

**铁律：启动快照只解释"本次启动发生了什么"，当前状态一律以本次实时探测为准。**

1. 打开/刷新/点「重新检查」时，**先读** `GET /__boot-state`（组件端口也从这里取，前端不复制端口表），**再并行**实时探测。
2. `boot.stale === true`（或 `present:false`）→ 快照不参与当前状态判定，只在基础运行行标注
   「启动记录已过期，本次判断以当前检查为准。」，技术详情里仍完整展示快照与 `staleReason`。
3. 当前探测优先：`healthy → 正常`；端口有响应但身份不符 → `需要注意`；无响应 → `不可用`。
4. **启动时 degraded、现在已恢复** → 行状态为「正常」，并附注
   「启动时这项功能曾经降级，现在已经恢复。」；技术详情里保留 `启动结果：degraded` 与
   `bridge：state=offline · reason.category=offline`。
5. **启动时正常、现在停止** → 行状态为「不可用」，并附注「启动时正常，之后停止了。」
6. 禁止因为 `boot-state.overall = normal` 就永久全绿：smoke 里把 Bridge mock 停掉后，总体立刻从
   「系统运行正常」变为「部分功能暂时不可用」。

---

## 5. 一键检查实现

`[重新检查]`（首次进入页面也会自动执行一次）：

- **真实探测**，全部复用既有客户端：同源 `/health`、`ibBridgeFetch`（带既有 token 逻辑）、
  `_activeCompanionRequest`、`IB.backendRestart.getStatus()`、视觉 `/health` 与安装标记 `HEAD`。
- **硬超时**：每个探测 `AbortController` + 2500ms；`readBootState` 同样。
- **单组件失败不崩页**：每个探测独立 `catch`，自身抛异常只把该行标成「状态未知」，
  其余行照常渲染（专项测试用 `PROBES.bridge = () => Promise.reject(...)` 实测）。
- **避免请求风暴**：`S.inflight` 去重（并发调用只跑一轮，7 个探测 + 1 次启动快照 = 最多 8 个请求）；
  `/api/diagnostics` 摘要是**按需**探测（只在展开技术详情或导出报告时拉一次），不参与每次检查。
- **有明确 loading**：进入检查时所有行显示「检查中」，按钮变「正在检查…」并禁用。
- **显示更新时间**：`最近检查：HH:MM:SS`。
- **不制造假进度条**：只有"检查中"文字与逐行状态。

---

## 6. 一键修复实际执行动作

按钮文案 `[尝试修复]`，只在**至少一行可恢复**时出现（bridge/active 不可用 + 重启控制面在线）。

实际执行链（全部是已经存在并验证过的动作，没有新能力）：

```
检测异常（本地增强 / 后台主动功能 = 不可用）
→ 判断是否属于可恢复本地服务（bridge / active）且 23116 重启控制面在线
→ 调用既有 window.ibRestartBackend()   （assets/js/backend-restart.js）
     POST http://127.0.0.1:23116/restart   → 202 Accepted
→ 轮询既有 IB.backendRestart.state()（每 700ms，硬上限 45s）
     restarting → ready | failed
→ 重新执行第 5 节的实时探测
→ 更新页面
```

- 成功：`本地功能已经恢复。`（smoke 实测：真实 `POST /restart` → mock 服务重启 → 轮询到 `ready` → 重新探测 → 「本地增强功能 正常」）
- 失败：`自动修复没有成功。你仍然可以继续使用可用功能。`，并保留「查看技术详情」
- 严格不做：**不假装修好**（失败后行状态仍是"不可用"）、**不无限重试**（每次点击只触发一次，`S.repairing` 互斥）、**不改用户配置 / 不删数据库 / 不清缓存 / 不换端口 / 不动 API Key**（专项测试对源码做禁止字面量断言）。
- 修复记录进入报告（`restart-local-services → ok|failed` + 时间）。

---

## 7. 明确"无法自动修复"的问题

页面直接写「此问题无法自动修复」并给下一步，**不提供永远失败的按钮**：

| 场景 | 判定依据 | 页面建议 |
| --- | --- | --- |
| 本地端口被其他程序占用 | 端口有响应但身份不符 | 关闭占用它的程序后重新打开 IB；具体是哪个程序看技术详情 |
| 重启控制面也不可用 | `23116 /status` 不通 | 关闭并重新打开 InternalBeyond |
| 主界面/页面服务异常 | 同源 `/health` 异常 | 关闭并重新打开；仍然不行请联系维护者 |
| 内置运行时损坏、安装文件缺失 | boot-state `fatal` / `reason.category`（`launcher-error` / `static-unavailable` / `path-unavailable` / `permission-denied` / `disk-full` / `write-failed`） | 在基础运行行标注"上次启动时主界面服务没有正常启动"，并引导重新安装/联系维护者 |
| API Key 无效、账号权限、额度受限、地址/模型配置错误 | P3 错误分类（`auth` / `forbidden` / `rate_limit` / `endpoint` / `model`） | 指向「API 设置」或提示稍后重试 |
| 视觉功能已安装但没起来 | 安装标记存在 + `/health` 不通 | 说明是可选项、不影响聊天；**P5 不实现 Vision installer** |

`canRepair()` 在不可修复场景返回 `false`，专项测试实测「端口冲突时『尝试修复』不会触发 restart」。

---

## 8. AI connection test

- 入口：`[测试 AI 连接]`，可先用下拉选择"测试哪个角色"（默认**当前角色**，没有当前角色则取第一个）。
- 明确告知：`测试会实际向 AI 服务发送一个很小的请求（可能产生少量费用）。`
- 调用链与聊天/P4 完全一致：`window.callApiChat(cfg, [{role:'user',content:'你好'}], {maxTokens:16, timeoutMs:30000, disableTools:true, _noWebSearch:true, wantMeta:false})`；
  smoke 实测：**只有 1 条 user 消息、无工具、非流式、只发一次请求**。
- **绝不遍历所有角色向所有 provider 发收费请求**。
- 失败文案全部复用 P3：401 → 「API 密钥无法使用」（`IBERR.AUTH.401`）、429 → 「AI 服务暂时拒绝了请求」（`IBERR.RATE_LIMIT.429`，不武断写成"余额不足"）。
  普通提示不含状态码/地址/密钥；`IBERR.detailsText` 里才有 `HTTP 状态：401`（仍无密钥）。
- 原始异常只进开发者 console，且经 `IBERR.redact` 脱敏。

---

## 9. 导出报告格式

`[导出诊断报告]` → `InternalBeyond-诊断报告-<ISO 时间>.txt`（UTF-8）：

```
InternalBeyond 诊断报告
生成时间：2026-09-09T02:11:52.031Z

【基本信息】        页面地址 / 浏览器 / 平台 / 语言 / 屏幕
【启动快照（本次启动）】 bootId / 阶段 / 结果 / 记录时间 / 记录年龄 / 是否过期 / Node 版本·来源·路径·是否满足要求 / 平台·架构 / 应用目录 / 服务管理器状态
【当前功能状态】     总体 + 六项能力的用户措辞
【组件（启动快照）】  static / bridge / active / restart / vision：state · healthy · probed · port · identity · version · reused · controlState · reason.category
【当前探测】         每个探测的 endpoint（脱敏 URL）、HTTP 状态、error、耗时、healthy、identity
【启动警告（仅代码）】 只输出 warning.code
【健康 / 诊断摘要】   Bridge /status 与 /api/diagnostics 的白名单字段（数字/布尔）
【最近错误码（P3 统一分类）】 IBERR.xxx @ 时间
【修复尝试】         时间 · restart-local-services → ok|failed
【AI 连接测试】       结果 / 时间 / 耗时 / P3 详情
【说明】             脱敏声明 + 未导出本地日志文件
```

**强制二次脱敏**：报告由**白名单字段**构造（绝不读取 `reason.message`、`systemPrompt`、聊天正文等自由文本），
最后整体再过一遍 `IBERR.redact(text, 60000)`。

**"最近必要日志片段"的处理**：IB 的日志文件（`logs/launcher.log`、`%LOCALAPPDATA%\InternalBeyond\logs\*.log`）
浏览器无法安全判定其内容，因此**不导出**，报告里明确写出这一点；取而代之的是
boot-state `warnings[].code`、P3 错误码、以及各探测的结构化结果。

---

## 10. 脱敏验证

**专项测试（`test_diagnostics.js` 第 G 节）**：把 7 类敌意内容注入**所有真实数据源**
（boot-state 的 `reason.message` / `warnings` / `path`、mock Bridge `/status` 的 `token`/`authorization`/`cookie`/`systemPrompt`/`lastMessage`、
`/api/diagnostics` 的 `service.name`/`warnings`、角色 `nickname`/`endpoint`/`apiKey`/`systemPrompt`、探测 endpoint）：

| 注入 | 结果 |
| --- | --- |
| `sk-live-DEADBEEF0123456789` | 不存在 |
| `Bearer eyABCDEFGHIJ0123456789` | 不存在 |
| JWT `eyJ...` | 不存在 |
| `?key=SECRET-QUERY-VALUE` | 不存在 |
| `Cookie: session=SECRETCOOKIEVALUE123` | 不存在 |
| 系统提示词全文 | 不存在 |
| 聊天正文 | 不存在 |

报告与技术详情**都不含** `apiKey` 字段值、`Authorization:` 头值；导出的 Blob 文本同样扫描通过。

**真实浏览器 smoke（`test_diagnostics_smoke.js`）**：同样 7 类内容注入真实 HTTP 服务后，
`J3) 报告密钥扫描通过`、`J4) 报告不含 apiKey 值`、`D2) 技术详情已脱敏`、`L1) console/异常里没有出现任何密钥或注入内容` 全部通过。

---

## 11. normal / degraded / recovered 实测

真实 Chrome + 真实静态服务 + 真实 `/__boot-state`（用 `IB_BOOT_STATE_DIR` 写入真实启动记录）：

| 场景 | 实测结果 |
| --- | --- |
| 全部正常 | 总体「系统运行正常」；基础运行/AI 聊天/本地增强/后台主动功能=正常；视觉未运行也仍为总体正常 |
| 启动快照 degraded、当前已恢复 | 写入 `overall=degraded`（bridge/active offline）的启动记录 → 页面仍显示「系统运行正常」，本地增强功能行附注「启动时这项功能曾经降级，现在已经恢复。」 |
| boot-state 过期 | 专项测试：`stale:true` 不参与当前状态判定，基础运行行标注「启动记录已过期…」 |
| Bridge 当前 down | 总体「部分功能暂时不可用」+「你仍然可以正常聊天。」；语音功能随之不可用；出现「尝试修复」 |
| Active 当前 down | 「后台主动功能暂时不可用。」（专项测试矩阵） |
| 双 down | 两行都不可用，总体 down（专项测试矩阵） |
| Vision 未安装 | 「未安装（可选）」+「不影响聊天」，**不进入 degraded**（专项测试 + smoke 实测已安装未启动同样不影响总体） |
| 主页面不暴露技术概念 | smoke：主页面文本中 `Bridge / Active / 23115 / 23114 / 127.0.0.1 / WebSocket / ws:// / Node / 端口` 一个都不出现；展开「技术详情」后才出现组件名与端口 |

---

## 12. restart success / failure 实测

smoke 用真实 mock 重启控制面（真实 `GET /status` + `POST /restart` 状态机）：

- **失败**：`/restart` 接单后状态机置 `failed` → 页面显示
  「自动修复没有成功。你仍然可以继续使用可用功能。」，且本地增强功能**仍然显示不可用**（不假装修好）。
- **成功**：`/restart` 接单后真实重启 mock Bridge（关闭端口 → 重新监听）→ 页面轮询到 `ready` →
  重新探测 → 「本地功能已经恢复。」→ 本地增强功能=正常 → 总体回到「系统运行正常」。
- 两次修复共触发 **2 次真实 `/restart`**（每次点击一次，无重复、无无限重试）。

---

## 13. Chrome smoke

`node test_diagnostics_smoke.js` → **43 通过 / 0 失败**，无未捕获异常、无资源泄漏（进程自然退出）。
覆盖：模块挂载、独立导航入口、首次自动检查、normal、主页面无技术概念、技术详情展开与脱敏、
启动 degraded + 当前恢复、Bridge down、修复 loading、restart 失败、restart 成功、修复后重新探测、
AI 连接测试成功、401 复用 P3 文案、报告导出与密钥扫描、P3 错误卡片跳转、console 无密钥。

专项测试 `node test_diagnostics.js` → **120 通过 / 0 失败**。

---

## 14. quick 回归

`node test-all.js --quick` → **static 35 项 · 48.2s · 1 失败 · service 16 项全部通过 · 总耗时 131.5s**。
唯一失败是 `encoding.bom.assets\js\middle-brain.js`（并行会话在途编辑，P5 禁触），
**`test_diagnostics.js` 已登记并在本次回归中 PASS（10.5s）**。

与本次改动直接相关的其它测试单独跑过：
- `test_error_catalog.js` 124/124（error-catalog.js 改动）
- `test_error_ui_smoke.js` 20/20（真实浏览器，P3 卡片行为未回归）
- `test_frontend_structure.js`：唯一失败为 `middle-brain.js` BOM（同上），新文件全部通过
- `scripts_check_html.js InternalBeyond.html`：66 个本地脚本 0 失败
- `test_boot_state.js` 36/36、`test_launcher.js` 16/16

---

## 15. P6 教程可直接引用的 Diagnostics 操作路径

**路径 A · 从导航进入（最常用）**
1. 点顶部导航栏 **Diagnostics**。
2. 页面自动开始检查，几秒后出现六行结果；看**第一行标题**就知道整体情况：
   「系统运行正常」/「部分功能需要注意」/「部分功能暂时不可用」。
3. 想知道具体是哪一项：看每行右边的状态标签（正常 / 需要注意 / 不可用 / 未安装（可选）/ 检查中 / 状态未知）。
4. 想重新确认：点 **重新检查**，底部会显示「最近检查：时:分:秒」。

**路径 B · 一键修复（本地功能异常时）**
1. 如果出现「本地增强功能 不可用」或「后台主动功能 不可用」，页面会给出 **尝试修复** 按钮。
2. 点它 → 按钮变「正在恢复…」→ 等十几秒。
3. 成功会看到 **本地功能已经恢复。**；失败会看到
   **自动修复没有成功。你仍然可以继续使用可用功能。**（此时聊天仍然可用）。
4. 失败后点 **查看技术详情** 看具体原因，再点 **导出诊断报告** 把 `.txt` 发给维护者。

**路径 C · 从设置页进入**
API 设置页顶部有一张「系统诊断」卡片，点 **打开系统诊断** 即可。

**路径 D · 从错误提示进入**
当出现本地服务错误卡片（例如「部分本地功能暂时不可用」）时，卡片上有 **系统诊断** 按钮，直接跳到诊断页。

**路径 E · 测试 AI 连接（可选）**
1. 在诊断页底部找到 **测试 AI 连接**（可先用下拉选角色，默认当前角色）。
2. 注意提示：**测试会实际向 AI 服务发送一个很小的请求（可能产生少量费用）。**
3. 成功显示「连接正常（x.x 秒）」；失败显示 P3 用户文案 + 处理建议。

**路径 F · 导出报告**
1. 点 **导出诊断报告** → 浏览器下载 `InternalBeyond-诊断报告-<时间>.txt`。
2. 报告可以直接发给维护者：不含 API Key / Authorization / Cookie / 提示词 / 聊天正文。

---

## 实测记录

| 测试 | 结果 |
| --- | --- |
| `node test_diagnostics.js` | **120 通过 / 0 失败** |
| `node test_diagnostics_smoke.js` | **43 通过 / 0 失败**（无 LEAK） |
| `node test_error_catalog.js` | 124 通过 / 0 失败 |
| `node test_error_ui_smoke.js` | 20 通过 / 0 失败 |
| `node test_frontend_structure.js` | 仅 `middle-brain.js` BOM（并行会话在途，非 P5） |
| `node scripts_check_html.js InternalBeyond.html` | 66 scripts / 0 失败 |
| `node test_boot_state.js` | 36 通过 / 0 失败 |
| `node test_launcher.js` | 16 通过 / 0 失败 |
| `node test-all.js --quick` | static 35 项 · 48.2s · 1 失败（`middle-brain.js` BOM，并行会话在途）/ service 16 项全部通过 · 总耗时 131.5s；`test_diagnostics.js` PASS |

---

## 已知限制

1. **Active 探测的 smoke 注入**：前端 `ACTIVE_COMPANION_URL` 固定为 `127.0.0.1:23114`，smoke 用**同形客户端**
   （`window._activeCompanionRequest`）指向 mock 服务；真实客户端逻辑未改动。
2. **视觉"是否安装"的判定**依赖 `.venv-vision/pyvenv.cfg` 存在（与 `start-vision-service.cmd` 的虚拟环境一致），
   通过同源 `HEAD` 探测；不读取任何 Python 环境内容。
3. **一键修复只覆盖 bridge/active**：静态页面服务、端口占用、内置运行时损坏、Provider 认证/额度问题明确标注"无法自动修复"。
4. **AI 连接测试会真的发一次请求**（很小、只测当前角色），已在按钮上方明示。
5. **不导出本地日志文件**（无法确认其内容是否敏感）；报告只带结构化字段、warning code 与 P3 错误码。
6. **boot-state 只有"本次启动"一条记录**，没有历史；页面按 `stale` 语义处理，不冒充当前状态。
7. 修复过程中（检查进行中）修复按钮会暂时隐藏，检查结束后重新出现。
