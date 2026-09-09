# InternalBeyond Zero-Setup / Consumer Readiness —— 第一阶段只读审计

> 状态：**只读审计完成，未修改任何运行时代码**（本文档为新建文档）。
> 目标读者：本项目开发者 / 决策者。
> 审计对象：`<repo-root>`（master，工作树含其他会话未提交改动）。
> 审计方式：直接读源码 + 真实日志 + 现有文档；所有结论均标注文件与行号依据。
>
> **一句话结论**：IB 的启动编排逻辑（检测/幂等/健康轮询/隐藏窗口/静默重启/日志脱敏）其实已经**基本建好**，缺的不是重写，而是三件事：
> ① 把 Node 从"用户必须预装"变成"随包内置"；② 把"可选服务失败 = 拒绝打开 UI"改成"降级可用"；③ 在 UI 里补上首启向导、诊断页与面向普通人的文案。
> 全项目**零 npm 依赖、零构建步骤**，这让"最小侵入"发行方案成为可能，也让引入 Electron/Tauri 等大框架显得毫无必要。

---

## 0. 审计范围与证据索引

| 证据 | 位置 |
|---|---|
| 零命令启动器（唯一真实编排逻辑） | `launch-internal-beyond.js` |
| 服务管理进程（Bridge/Active 父进程 + 静默重启控制面） | `local-services-runner.js` |
| 静态 Web 服务（localhost 源，AudioWorklet 必需） | `internal-beyond-server.js` |
| 普通用户入口 | `启动 InternalBeyond.vbs`、`Start Internal Beyond.cmd` |
| 开发者入口 | `start-local-services.cmd`、`start-bridge-service.cmd`、`start-active-service.cmd` |
| 桌面快捷方式安装器 | `create-desktop-shortcut.cmd` |
| Provider 单一事实源 | `assets/js/provider-directory.js` |
| API/角色编辑器 | `assets/js/social.js`（`addNewApi`/`editApi`/`saveCurrentApi`/`onProviderChange`） |
| 错误分类与角色化文案 | `assets/js/error-catalog.js`（`IBERR`） |
| 一键重启后端（前端） | `assets/js/backend-restart.js` + runner `127.0.0.1:23116` |
| 本机模型探测 | `assets/js/local-first.js` |
| Bridge 健康 / 状态 / 诊断快照 | `bridge/routes.js`（`/health`、`/status`、`/api/diagnostics`、`safeConfigSnapshot`） |
| Active 健康 | `active/http.js`（`/health`） |
| 凭据保险箱 | `active/credential-vault.js`、`assets/js/local-vault.js` |
| 现有帮助页 | `InternalBeyond.html` `#page-guide` + `#guide-toc` |
| 约束性决策 | `DECISIONS.md` D1/D2/D5/D7、`INTERNALBEYOND_AI_RULES.md` |
| 真实启动日志 | `logs/launcher.log` |
| 测试入口 | `test-all.js`、`test_launcher.js`、`test_local_services_runner.js` |

---

## 1. 当前真实启动架构

### 1.1 进程拓扑（实机验证）

```
用户双击 桌面 InternalBeyond.lnk
        └─> 启动 InternalBeyond.vbs            （wscript，无控制台）
              ├─ 自定位目录、设置 CurrentDirectory
              ├─ where node.exe  → 找不到则 MsgBox 后退出
              └─ node.exe launch-internal-beyond.js   （winStyle=0 隐藏）
                    ├─ 1. local-services-runner.js --json   读 Bridge/Active 健康
                    ├─ 2. 需要时 spawn local-services-runner.js（detached, windowsHide）
                    │        ├─ Bridge  127.0.0.1:23115  ib-bridge-service.js
                    │        ├─ Active  127.0.0.1:23114  active-message-service.js
                    │        ├─ Vision  127.0.0.1:8765   （仅 --vision，可选）
                    │        └─ 重启控制面 127.0.0.1:23116（runner 内置）
                    ├─ 3. 健康轮询（最长 25s）
                    ├─ 4. 检测/启动 internal-beyond-server.js  127.0.0.1:23120
                    ├─ 5. 健康轮询（最长 15s）
                    └─ 6. cmd /c start "" http://127.0.0.1:23120/InternalBeyond.html
```

端口分配（全部可用环境变量覆盖）：Bridge `23115`、Active `23114`、Vision `8765`、静态 Web `23120`、重启控制面 `23116`。

### 1.2 `launch-internal-beyond.js` 的真实行为

- 编排四步：服务检测 → 按需启动 → 健康轮询 → 打开浏览器（文件头注释与实现一致）。
- **健康探测是真的**：`servicesStatus()` 调用 `local-services-runner.js --json`，由 runner 请求 `/health` 并校验身份（Bridge: `data.server === 'IB Bridge'`；Active: `data.service === 'internal-beyond-active-messages'`）。端口被陌生进程占用会判为 `conflict` 而**不会**误判为健康，也不会重复拉起第二份。
- **幂等**：健康则复用；"正在启动"（PowerShell 查 `local-services-runner` 命令行）则等待不重复拉起。
- **静态服务身份校验**：`/health` 必须返回 `{ok:true, server:'InternalBeyond Web'}` 才算健康；端口被他人占用 → `conflict` 报错，不覆盖。
- **子进程全部 `windowsHide: true` + `detached` + `stdio:'ignore'`**，不弹黑框。
- **⚠ 关键缺陷：可选服务失败会导致"整个 UI 都打不开"**：
  - `launch-internal-beyond.js:198-204` —— 若 Bridge/Active 25s 内未健康，直接 `errorBox(...)` 并 `return {ok:false, reason:'services'}`，**在打开浏览器之前就返回**。
  - 这与 `README.md:282`「本地 Bridge 后端（可选）」、`DECISIONS.md` D2「Bridge 不做主聊天代理」自相矛盾：主聊天是浏览器直连各厂商 API 的，Bridge 挂了不应该阻断使用。
  - 对零基础用户而言，这等于"一个后台组件出问题 → 软件完全打不开，只弹一个英文错误框"。

### 1.3 `local-services-runner.js` 的真实行为

- 作为 Bridge/Active 的**父进程**统一托管，`SERVICES[].command` 用的是 **`process.execPath`**（`local-services-runner.js:56-80`）——这一点对内置 runtime 方案极其关键：**只要 runner 由内置 node 启动，它拉起的 Bridge/Active 自动也是内置 node，无需改动服务启动代码。**
- 每服务独立日志：`%LOCALAPPDATA%\InternalBeyond\logs\{bridge,active}.log`（`appendLog`）。
- **静默重启控制面**（`127.0.0.1:23116`）：`POST /restart`（互斥、202 接单、后台跑）、`GET /status`（`idle|restarting|ready|failed`）；状态机 `runRestart()` 走 停止 → 等端口释放 → 重启 → 健康确认。
- **安全边界做得很克制**：`processMatchesService()` 只杀"命令行同时包含项目目录名 + 服务脚本名"的进程，绝不误杀无关进程；`restartOriginAllowed()` 只放行 loopback/`file://` Origin。
- **日志脱敏已存在**：`redact()` 屏蔽 `apiKey/token/secret/bearer/x-ib-token/openai_key`、`sk-...`、`Bearer ...`、`AIza...`，并把完整命令行折叠成 `[script]`。→ **诊断报告导出必须复用这套规则，不要另写一套。**

### 1.4 `internal-beyond-server.js` 的真实行为

- 仅绑定 `127.0.0.1:23120`，把**整个项目根目录**当作静态根提供服务；`/health` 返回身份串；有路径穿越防护；端口被占用时 `exit 3`（供启动器区分"冲突"与"失败"）。
- 走 localhost 而非 `file://` 的原因（README/架构已记载）：`file://` 空源下 AudioWorklet 加载会被拒，语音采集失效。
- **⚠ 发行注意**：`resolveRequest()` 的根是 `__dirname`，因此会把 `logs/`、`.git/`、`browser-data/`、`test_*.js` 一并对外提供。开发者环境无害（仅回环），但**发行包必须按白名单裁剪载荷**，不要整仓打包。

### 1.5 前端连接关系（用户实际接触面）

| 能力 | 前端接入点 | 失败时的用户可见文案 |
|---|---|---|
| Bridge WebSocket | `assets/js/bridge.js`，默认 `ws://127.0.0.1:23115`（DIY → 后端连接，`IBNET`） | `bridge.js:680`：「Bridge 未连接。请先双击运行 start-bridge-service.cmd，然后在 DIY → 后端连接 填写 ws://127.0.0.1:23115 并启用。」**纯开发者指令** |
| 后端静默重启 | `assets/js/backend-restart.js`，向 `127.0.0.1:23116` 发 `POST /restart`，把「重启后端」按钮注入 Bridge 卡片 | 「后端重启失败，请查看诊断信息」（但没有"诊断信息"可看） |
| Active companion | `assets/js/active-diary.js` `_activeCheckCompanion()` → `127.0.0.1:23114/health` | 连接失败走 toast / 降级 |
| 数据存储 | 浏览器 IndexedDB `InternalBeyondDB` v23（32 个 object store），**没有服务端数据库** | 无 |

> **重要事实**：所谓"数据库"是**浏览器 IndexedDB**，不是服务端 DB。诊断页的"数据库"一项必须按这个事实探测（`navigator.storage.estimate()` + 打开库 + 统计各 store 条数），不能凭空编造服务端 DB 状态。

### 1.6 运行时依赖事实（决定发行形态的关键）

- **全仓无 `package.json`、无 `node_modules`**（已实测）。所有 `require()` 均为 Node 内置模块（`path/fs/http/os/child_process/crypto/net/url/vm/tls/util`）。
- 唯一运行时外部依赖是 **Node.js 本身**，版本下限 **18**（`fetch` / `AbortSignal`；`active-message-service.js:21` 明确检查 `typeof fetch !== 'function'`）。
- 生产代码**未**使用 `structuredClone` / `AbortSignal.timeout` / `crypto.randomUUID` / `fs.cpSync` / `ReadableStream` 等更高版本 API（已全仓 grep 确认），因此可安全钉在任一 LTS 线。
- 前端**零构建**（`DECISIONS.md` D5：原生经典 `<script>` 按固定顺序加载，`InternalBeyond.html` 约 3400 行、60+ 个 script 标签）。

---

## 2. 当前安装 / 使用门槛

### 2.1 门槛清单（按用户实际会卡住的顺序）

| # | 门槛 | 证据 | 对零基础用户的后果 |
|---|---|---|---|
| G1 | **必须先装 Node.js 18+ 并在 PATH 中** | `启动 InternalBeyond.vbs` `where node.exe`；4 个 `.cmd` 同样检查 | 最硬的墙。不知道 Node 是什么的人到此结束 |
| G2 | 要在 6 个入口文件里选对双击哪个 | 1 个 `.vbs` + 5 个 `.cmd` | 选择困难；点错会看到控制台 |
| G3 | `.cmd` 会弹可见控制台窗口 | `start-*.cmd` 直接 `node.exe ...` | 违反"不得弹黑框" |
| G4 | 要理解 `ws://127.0.0.1:23115`、端口、WebSocket、"勾选启用并点击连接" | `bridge.js:680`；README 快速开始 | 完全不可理解 |
| G5 | 首启无向导，空状态是「还没有添加API」 | `assets/js/social.js:631` | 不知道下一步该干什么 |
| G6 | 要知道去哪拿 API Key、填哪个字段、选哪个模型 | `#page-api` 编辑器（字段极多） | 容易填错或放弃 |
| G7 | 启动失败只弹英文 MessageBox | `launch-internal-beyond.js:202/211/220/235` | 「Local services did not become healthy. Bridge=offline…」 |
| G8 | 日志路径文案自相矛盾 | `Start Internal Beyond.cmd` 说 `%LOCALAPPDATA%\InternalBeyond\logs\launcher.log`，实际 `launch-internal-beyond.js` 写 `ROOT\logs\launcher.log` | 按提示找不到文件 |
| G9 | 无安装包 / 无卸载 / 无签名 / 无更新 | 仓库无任何打包脚本 | 只能 git clone / 解压 ZIP |
| G10 | Bridge/Active 失败 = UI 打不开（见 1.2） | `launch-internal-beyond.js:198-204` | 可选组件拖垮整个应用 |

### 2.2 当前"发行形态"事实

- 今天的分发方式就是 **GitHub 仓库 / ZIP 解压**（README「开始游戏」第 1 步）。
- 无 `package.json`、无 `electron`/`tauri`/`webview2`/`pkg`/`nexe` 任何痕迹（已全仓 grep）。
- 现有"安装器"只有 `create-desktop-shortcut.cmd`：创建桌面 `.lnk` 指向 `.vbs`，图标复用 `IB-icon.ico`。**这是唯一可复用的安装动作。**
- 许可为 **PolyForm Noncommercial 1.0.0**（代码）+ **CC BY-NC-SA 4.0**（素材/文档），`LICENSES/COPYRIGHT-NOTICE.md` 明确**禁止收费分发/打包进付费产品**。→ `InternalBeyond-Setup.exe` **只能免费、非商业分发**；这一点必须写进发行方案，不能含糊。

---

## 3. 可直接复用能力清单（禁止重造）

| 能力 | 现有实现 | 复用方式 | 不要做什么 |
|---|---|---|---|
| Provider 元数据 | `assets/js/provider-directory.js`：15 个 provider（name/endpoint/model/format/vision/streaming）+ `providerFormat()`，UMD 双端可用 | 向导**只读** `PROVIDERS` 渲染列表与默认值 | 不要新建第二份 provider 表、不要硬编码模型名 |
| Provider → 端点/模型联动 | `social.js:441` `onProviderChange()` | 向导选择 provider 后调用它 | 不要重写填充逻辑 |
| API/角色 CRUD | `social.js`：`addNewApi()` / `editApi()` / `saveCurrentApi()` / `renderApiList()` / `loadApiConfigs()` / `_persistApiConfig()` | 向导**复用同一条保存路径**（含昵称查重、@handle 查重、voice 校验） | 不要旁路写库，否则校验与排序语义分叉 |
| "角色 = API 配置"这一事实 | `apiConfigs` 同时承载 provider/密钥与昵称/头像/关系/系统提示词；`friends` 列表即 `apiConfigs` | 向导第 6 步"创建角色"= 同一次保存 | 不要引入独立的 characters 表 |
| 密钥就绪判断 | `_ibApiHasCredential(cfg)`、`_ibIsLoopbackEndpoint(endpoint)` | 向导校验 + 诊断页 | 不要自写"有没有 key"的判断 |
| 本机模型探测 | `local-first.js:104` `probeModel()`：仅允许 `127.0.0.1`，OpenAI 兼容走 `/v1/models`、Ollama 走 `/api/tags` | 向导"本机模型"分支 + 诊断页"Provider/API" | 不要开放对外地址探测 |
| 错误分类 + 角色化文案 | `assets/js/error-catalog.js` `IBERR`：11 个类别（network/timeout/rate_limit/auth/provider/model/bad_request/empty_output/content/aborted/unknown）+ `classify/text/err/report` | **扩展**新类别与"详细信息"抽屉 | 不要另建错误映射表；不要删掉 console 原始诊断 |
| 后端静默重启 | `backend-restart.js` + runner `23116` | 诊断页"一键修复"直接调用 `ibRestartBackend()` | 不要在浏览器里再写一套杀进程逻辑 |
| 服务健康 | runner `--json`、Bridge `/health` `/status`、Active `/health`、Web `/health` | 诊断页全部基于这些真实探测 | 不要伪造状态 |
| Bridge 诊断快照 | `bridge/routes.js:126` `diagnosticsSnapshot()`：服务/数据/能力/告警；`safeConfigSnapshot()` 已掩码所有密钥 | 诊断页"导出报告"直接消费 | 不要自己拼 config 快照（会漏掩码） |
| 日志脱敏 | `local-services-runner.js` `redact()` | 导出报告复用同一规则（可移植为共享模块） | 不要写第二套正则 |
| 凭据保险箱 | `active/credential-vault.js`（AES-256-GCM）、`assets/js/local-vault.js`（PBKDF2 加密导出） | 保持现状；诊断报告绝不读取 vault 明文 | 不要把 key 写进报告/日志 |
| 帮助页与目录 | `#page-guide` + `#guide-toc` + `guide-feature` 卡片样式 | 零基础教程挂到此处，复用样式 | 不要新造一套文档 UI |
| 桌面快捷方式 + 图标 | `create-desktop-shortcut.cmd`、`IB-icon.ico` | Installer 直接沿用图标与快捷方式语义 | 不要重新生成图标 |
| UI 基础件 | `toast()`、`window.IB` 命名空间、玻璃拟态 CSS | 向导/诊断页沿用 | 不要引入 UI 框架 |
| 测试基座 | `test-all.js`（static/service/browser 三组）、`test_launcher.js`、`test_local_services_runner.js` | 每个 Phase 的回归门 | 不要绕过既有测试 |

---

## 4. Zero-Setup 目标架构

### 4.1 分层设计（最小侵入）

```
┌─ L0 发行层（新增，构建期）────────────────────────────────┐
│ Inno Setup 6 脚本 → InternalBeyond-Setup.exe               │
│ 载荷白名单 + 内置 runtime + 许可声明 + 快捷方式            │
└────────────────────────────────────────────────────────────┘
┌─ L1 引导层（改造既有，运行期）────────────────────────────┐
│ 启动 InternalBeyond.vbs                                    │
│   node 解析顺序: IB_NODE → runtime\node\node.exe → PATH    │
│   → 仍找不到：中文产品化提示（而非英文 MsgBox）            │
│ launch-internal-beyond.js                                  │
│   可选服务失败 → 降级打开 UI（不再阻断）                    │
│   写 boot-state.json（供诊断页读取真实 runtime 信息）        │
└────────────────────────────────────────────────────────────┘
┌─ L2 服务层（完全复用，零改动）────────────────────────────┐
│ local-services-runner.js（process.execPath 自动继承内置 node）│
│ Bridge 23115 / Active 23114 / Restart 23116 / Static 23120 │
└────────────────────────────────────────────────────────────┘
┌─ L3 体验层（新增前端模块）────────────────────────────────┐
│ assets/js/first-run.js     首次启动向导                     │
│ assets/js/diagnostics.js   系统诊断页                       │
│ assets/js/error-catalog.js 扩展：服务连接类错误 + 详细信息   │
│ #page-guide 新增「新手入门」章节 + 真实截图管线              │
└────────────────────────────────────────────────────────────┘
```

### 4.2 核心原则

1. **不改服务运行时**：Bridge/Active/静态服务/重启控制面一行不动（最多给静态 `/health` 加只读字段）。
2. **不新增第二套元数据**：provider 只认 `provider-directory.js`；角色只认 `apiConfigs`。
3. **降级可用**：Bridge/Active 是可选能力，UI 必须能开；缺失能力在 UI 内明确告知并提供修复入口。
4. **诚实探测**：诊断页每一条都来自真实端点或真实文件；未知就显示"未知"，禁止假绿。
5. **零隐式行为**：不自动联网下载、不自动更新 runtime、不静默改用户配置（遵循 `INTERNALBEYOND_AI_RULES.md` §5）。
6. **开发流不破坏**：`start-*.cmd`、`node local-services-runner.js --status/--json`、`test-all.js` 全部保持可用；PATH node 仍是开发者的默认路径。

---

## 5. 内置 Node Runtime 方案

### 5.1 版本与来源

| 项 | 决策 |
|---|---|
| 版本 | 钉死一条 **LTS** 线的**精确版本号**（建议 Node 22 LTS；下限 18，实测未用更高 API） |
| 来源 | 官方 `https://nodejs.org/dist/v<ver>/win-x64/node.exe`（或 `node.zip` 取 `node.exe` + `LICENSE`） |
| 校验 | 下载后核对官方 `SHASUMS256.txt`，把 SHA-256 写进 `runtime/node/SHA256SUMS` 与安装器脚本 |
| 目录 | `runtime/node/node.exe`、`runtime/node/LICENSE`、`runtime/node/VERSION`、`runtime/node/SHA256SUMS` |
| 体积 | 单个 `node.exe` 约 **80–90 MB**（实测本机 v24 为 89 MB）；安装器 LZMA2 压缩后约 **25–30 MB** |
| 平台 | 首期仅 `win-x64`。`win-arm64` 后续按需补，不阻塞首版 |

### 5.2 解析顺序（所有入口统一）

```
IB_NODE（显式覆盖，测试/排障用）
  → <install>\runtime\node\node.exe（内置，发行版唯一路径）
  → PATH 中的 node.exe（开发者）
  → 失败：中文产品化提示 + 指向诊断页
```

- `.vbs` 负责解析并把绝对路径传给 `launch-internal-beyond.js`。
- `launch-internal-beyond.js` 与 runner **无需改 spawn 逻辑**：只要用内置 node 启动 runner，`process.execPath` 已保证 Bridge/Active 同用内置 node。
- 建议额外让 `SERVICES[].command` 支持 `IB_NODE` 覆盖（改动极小，便于测试注入）。

### 5.3 更新方式

- **版本随 IB 发行绑定**，不做运行时自动更新（避免隐式网络请求）。
- 构建期脚本 `scripts/update-node-runtime.ps1`（**仅开发者使用，不随发行包分发**）：下载 → 校验 → 替换 → 更新 VERSION/SHA256SUMS。
- 诊断页显示实际版本、路径、是否内置（读 `boot-state.json`）。
- 发行说明里记录"本次绑定 Node 版本"。

### 5.4 安全维护与许可

- 订阅 Node 安全发布；LTS 补丁版落地后**重建安装包**（写进 `docs/RELEASE.md` 的固定流程）。
- 权限：服务仍只监听回环；不写 PATH、不做全局安装、不注册系统服务。
- 许可：Node.js 为 MIT（含 V8/OpenSSL 等第三方许可），**允许再分发**，但必须随包提供其 LICENSE 文本。计划：
  - 新增 `LICENSES/THIRD-PARTY-NODE.md`（说明来源、版本、许可、SHA-256）；
  - `LICENSES/COPYRIGHT-NOTICE.md`「第三方内容」段落补一行；
  - 安装包内保留 `runtime/node/LICENSE` 原文。
- **不采用** `pkg` / `nexe`（已停止维护）与 Node SEA 单文件（构建复杂、体积更大、排障更难）。首版就用 `node.exe`。

### 5.5 风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| 体积膨胀 | 安装包 +25–30MB | 可接受；不引入 Electron（那会 +150MB 起） |
| Node 安全补丁滞后 | 绑定版本不会自动更新 | 固定重建流程 + 版本可见于诊断页 |
| 与用户已装 Node 冲突 | 不会：内置路径优先，且不改 PATH | 解析顺序 + `IB_NODE` 覆盖 |
| 杀软误报 | 未签名 + 内置 exe 可能触发 | 代码签名（见 §6） |
| 许可合规 | 必须随包 LICENSE | `THIRD-PARTY-NODE.md` + 原文 |

---

## 6. Installer / Launcher 方案

### 6.1 安装器选型

| 方案 | 结论 |
|---|---|
| **Inno Setup 6** | **推荐**。免费（非商业可自由使用）、单文件 `Setup.exe`、中文界面成熟、无 MSI/WiX 复杂度、支持 per-user 免管理员安装 |
| NSIS | 备选，能力相当，脚本更底层 |
| MSI / WiX | 拒绝：对单用户本地应用过重，且安装体验更差 |
| Electron / Tauri / WebView2 打包 | **拒绝**。违反 D5 零构建，体积与维护成本都远超收益；Windows 10/11 自带 Edge 已满足浏览器需求 |
| 直接 ZIP | 保留为开发者分发通道，不作为普通用户形态 |

### 6.2 安装包设计

- **安装范围**：默认 **per-user** → `%LOCALAPPDATA%\Programs\InternalBeyond`，**不提权、不弹 UAC**（零门槛关键）。
- **载荷白名单**（不整仓打包）：
  - 必需：`InternalBeyond.html`、`assets/**`、`game/**`、`apps/**`、`bridge/**`、`active/**`、`IB-icon.ico`
  - 服务根脚本：`ib-bridge-service.js`、`active-message-service.js`、`internal-beyond-server.js`、`local-services-runner.js`、`launch-internal-beyond.js`
  - 启动入口：`启动 InternalBeyond.vbs`（安装时复制为 ASCII 内部名，快捷方式显示名保持「InternalBeyond」）
  - 运行时：`runtime/node/**`
  - 许可与文档：`LICENSE`、`LICENSES/**`、`docs/**`（可裁剪为发行子集）
  - 可选：`vision/**`（Python 视觉助手，默认不装或标记为高级可选）
- **排除**：`logs/`、`browser-data/`（89MB Chromium profile）、`.git/`、`.dsh*/`、`.playwright-mcp/`、`.venv-vision/`、`__pycache__/`、`test_*.js`（91 个）、`tmp_ib_probe*.js`、`docs/*.results.json`。
  - 附带收益：静态服务根不再暴露测试/日志/仓库元数据。
- **快捷方式**：开始菜单 + 可选桌面，指向 `.vbs`（无控制台），`IconFilename = IB-icon.ico`，`WorkingDir = 安装目录`。
- **卸载**：Inno 内置；**默认不删除 `%LOCALAPPDATA%\InternalBeyond` 用户数据**，卸载时询问。
- **代码签名**：强烈建议 Authenticode（OV/EV）。未签名时 Windows SmartScreen 会拦一次，教程必须明确写出「更多信息 → 仍要运行」，并在验收里视为已知限制而非缺陷。

### 6.3 启动器改造点（小改，不重写）

| 改动 | 文件 | 说明 |
|---|---|---|
| runtime 解析顺序 + 中文失败提示 | `启动 InternalBeyond.vbs` | 先找 `runtime\node\node.exe`，再 PATH |
| **可选服务降级不阻断** | `launch-internal-beyond.js` `main()` | Bridge/Active 失败仍启动静态服务并打开 UI，把降级原因写入 boot 状态 |
| 产品化错误文案 | `launch-internal-beyond.js` `errorBox` | 中文 + 可操作建议；原始英文保留在日志 |
| 写 `boot-state.json` | `launch-internal-beyond.js` | `{nodePath,nodeVersion,bundled,services:{bridge,active,restart},webPort,degraded,reason}`，供诊断页读取真实状态 |
| 单实例保护 | `launch-internal-beyond.js` | 防重复双击拉起多个 runner |
| 日志路径统一 | `launch-internal-beyond.js` / `.cmd` | 统一到 `%LOCALAPPDATA%\InternalBeyond\logs\launcher.log`（per-user 安装下项目目录可能只读） |
| `IB_NODE` 支持 | runner `SERVICES[].command` | 便于测试与排障 |

> **保留**：`start-local-services.cmd` / `start-bridge-service.cmd` / `start-active-service.cmd` / `--status` / `--json` / `--debug` 全部不动，开发者工作流零变化。

---

## 7. First-Run Setup Wizard 方案

### 7.1 落点与触发

- 新文件：`assets/js/first-run.js`（经典脚本 + IIFE，注册到 `window.IB`），在 `social.js` **之后**加载（需要 `PROVIDERS` 与 `saveCurrentApi`）。
- 触发：DB 就绪后检查 `apiSettings['ibSetupV1Done']`；未完成且 `apiConfigs.length === 0` → 显示向导。
- 状态存 **IndexedDB `apiSettings`**（不是 localStorage），随导出/导入一起迁移（符合 D7 不升 DB_VER）。
- 入口：向导可跳过；帮助页/设置页提供「重新运行设置向导」。

### 7.2 七个步骤（与需求逐条对应）

| 步 | 页面 | 复用 | 新增 |
|---|---|---|---|
| 1 | 欢迎 | 现有玻璃拟态 CSS、`toast` | 说明"数据只在本机 / 不联网也能用基础功能" |
| 2 | 选择 AI Provider | `PROVIDERS` 全量渲染；`onProviderChange()` 填充端点/模型 | 分组标注"国内可直连"；「本机模型」分支 |
| 3 | 填写 API Key | `_ibApiHasCredential()`、`_ibIsLoopbackEndpoint()` | 密码型输入 + 各厂商控制台入口链接（**独立帮助表，不是 provider 元数据**） |
| 4 | 选择 / 检测模型 | `PROVIDERS[p].model` 预填；`local-first.js` 的 `/v1/models` URL 推导 | OpenAI 兼容 / Anthropic / Gemini 三形态的模型列表获取（注意浏览器 CORS，失败则回退手填） |
| 5 | 测试连接 | **走既有 `callApiChat` 真实链路**（1 token 最小请求） | 结果经 `IBERR` 产品化 + 「详细信息」展开原始错误 |
| 6 | 创建第一个角色 | `addNewApi()` / `saveCurrentApi()`（昵称查重、关系、系统提示词默认值 `getDefaultPromptForTheme()`、头像可选） | 极简字段子集 |
| 7 | 完成并进入聊天 | `navTo('chat')` + 选中该角色 | 「跳过，稍后配置」 |

### 7.3 实现约束

- **不新建 provider 元数据**：只读 `PROVIDERS`；厂商控制台链接放独立静态帮助表并注明"仅帮助链接"。
- **不旁路保存**：复用 `saveCurrentApi()`，以"临时填充现有编辑器 DOM → 调用保存"的适配器方式接入，确保昵称/@handle 查重与持久化语义与手动编辑**完全一致**。
  - 若 DOM 耦合在实施中被证明脆弱，再考虑给 `saveCurrentApi(btn, overrides)` 加一个可选参数（最小缝），**不得**复制保存逻辑。
- 向导不产生任何网络请求，除了用户主动点击的"检测模型 / 测试连接"。

---

## 8. System Diagnostics 方案

### 8.1 页面落点

- 新文件 `assets/js/diagnostics.js` + 新页面 `#page-diagnostics`（导航新增「诊断」入口）。
- 理由：验收标准要求"本地服务异常时用户能自己诊断和恢复"，埋在设置页深处不利发现；错误提示需能一键跳转过去。
- 懒加载：进入页面才探测，避免拖慢启动。

### 8.2 探测项（全部基于真实端点/文件，不伪造）

| 组件 | 真实探测 | 依据 |
|---|---|---|
| IB 主程序 / 静态服务 | `GET 127.0.0.1:23120/health` → `{ok,server:'InternalBeyond Web'}` | `internal-beyond-server.js` |
| Bridge | `GET 127.0.0.1:23115/health` + `/status` + `/api/diagnostics` | `bridge/routes.js` |
| Active Companion | `GET 127.0.0.1:23114/health` → `{ok,service:'internal-beyond-active-messages',version,...}` | `active/http.js:160` |
| 重启控制面 | `GET 127.0.0.1:23116/status` | `local-services-runner.js` |
| 内置 Node Runtime | 读 `boot-state.json`（nodePath/nodeVersion/bundled） | 新增（启动器写入） |
| 数据库 | IndexedDB 打开 + `navigator.storage.estimate()` + 各 store 计数 | `assets/js/core.js` `openDB()` |
| Provider / API | 遍历 `apiConfigs`：是否有 key / 是否 loopback / 最近一次错误类别（内存环形记录，不含正文）+ 可选「测试连接」 | `IBERR`、`_ibApiHasCredential` |
| TTS | Bridge `/status` 的 `tts/mimoTts/voiceAsr` + `/api/tts/voices` | `bridge/routes.js` |
| 磁盘 / 存储占用 | Bridge `/api/diagnostics` usage | 同上 |

### 8.3 三个动作（每个都写清"实际执行什么"）

- **一键检查**：并发跑全部探测 → 表格 `正常 / 警告 / 失败` → 每行给"人话原因" + 「详细信息」抽屉（原始 HTTP 状态/JSON、日志尾部）。
- **一键修复**（只放真实动作，禁止假按钮）：
  1. **重启本地服务** → `POST http://127.0.0.1:23116/restart`（复用 `ibRestartBackend()`）。界面明示："正在重启 Bridge 与 Active 本地服务，约 10–30 秒。"
  2. **重新检测** → 重跑检查（无副作用）。
  3. **测试 AI 连接** → 对该角色发最小真实请求。
  - **明确不可自动修复**并如实标注：端口被陌生进程占用、runtime 缺失/损坏、网络/代理问题、API Key 无效、防火墙拦截。这些只给"手动步骤"，不装作能修。
- **导出诊断报告**：
  - 内容：版本与端口、各探测结果、`boot-state.json`、Bridge `diagnosticsSnapshot()`（**已掩码**）、前端 `apiConfigs` **仅** `{id, nickname, provider, model, endpoint, hasKey:boolean}`、最近 N 条错误类别（不含响应正文）、各服务日志尾部（**经 `redact()`**）。
  - **硬约束**：不包含任何 `apiKey` / `token` / `Authorization` / 保险箱明文。导出后自检一次（对生成文本跑同一套 `redact()` 正则做二次确认）。

### 8.4 诚实性设计

- 探测失败 → 显示"未运行"或"未知"，**绝不**显示绿色。
- 每个状态都带"最后检查时间"与"数据来源"（例如"来自 127.0.0.1:23115/health"）。
- 与 `error-catalog.js` 共用类别词表，避免两套术语。

---

## 9. 零基础图文教程信息架构

### 9.1 落点

- **产品内**：`#page-guide` 顶部新增「新手入门」章节（复用 `guide-feature` / `#guide-toc` 样式与目录）。
- **仓库内**：`docs/ZERO-BASIS-GUIDE.md`（面向普通用户的独立文档）。
- 首启向导完成页提供「查看新手教程」入口。

### 9.2 截图策略（禁止伪造截图）

- 现阶段**没有**任何教程截图，因此：
  1. 先交付**纯文字 + 编号步骤 + 真实 UI 元素名**版本（可立即用，不含假图）；
  2. 同步建**真实截图管线** `scripts/capture-guide-shots.js`（dev-only，复用既有 CDP/Playwright 测试基建）：在 `127.0.0.1:23120` 上驱动真实应用，按脚本化步骤截 PNG 到 `docs/guide/shots/`；
  3. 箭头/高亮用**数据化标注** `docs/guide/annotations.json`（元素选择器 + 序号 + 文案），由小查看器叠加渲染 —— 这样 UI 改版后**可重新生成**，不用手改图。
- 在截图尚未产出前，文档中不放占位假图，只写"（此处为截图：<具体界面>）"。

### 9.3 章节结构

1. 开始之前 —— 这是什么 / 我的数据存在哪 / 需要联网吗 / 需要懂编程吗（不需要）
2. 安装 —— 下载 → 双击安装 → 可能出现的 SmartScreen 提示 → 桌面图标
3. 第一次启动 —— 双击图标 → 后台自动启动 → 浏览器自动打开 → 期间不要关掉什么
4. 配置第一个 AI —— 向导 7 步逐步说明；「API Key 从哪来」通用说明 + 各厂商控制台入口
5. 创建你的角色 —— 昵称 / 关系 / 系统提示词 / 头像
6. 开始聊天 —— 发第一条消息 / 附件 / 流式与停止 / 切换角色
7. Memory —— 什么会被记住 / 在哪看 / 怎么删
8. 主动消息 —— 开关怎么开 / 关掉浏览器后仍运行的前提
9. 朋友圈（Moments）—— 发布、评论、AI 之间互动
10. 语音 —— 语音消息 / 语音通话 / TTS 音色
11. 其他模块速览 —— Calendar / Blog / Letters / ICode / Room
12. 常见故障 —— 6 个高频场景 + 一键诊断入口（见 §8）
13. 数据备份与迁移 —— 导出 / 导入 / 加密保险箱

每节统一四段式：**目标 → 你会看到什么 → 你该点什么 → 出错了怎么办**。

---

## 10. 分 Phase 实施计划

> 顺序原则：先让"能装上、能打开"，再让"会配置"，再让"能自愈"，最后"能发行"。每 Phase 结束都必须保持 `test-all.js --quick` 绿 + 开发者入口可用。

| Phase | 目标 | 交付物 | 完成判据 |
|---|---|---|---|
| **P0** | 只读审计（本文件） | `docs/history/zero-setup/ZERO-SETUP-AUDIT.md` | 本文件 |
| **P1** | 内置 Node Runtime + 入口解析 | `runtime/node/**`、`.vbs` 解析改造、`scripts/update-node-runtime.ps1`、`LICENSES/THIRD-PARTY-NODE.md` | 删掉 PATH 中的 node 仍能启动；`IB_NODE` 可覆盖 |
| **P2** | 启动器零门槛化 | `launch-internal-beyond.js`（降级不阻断 + 产品化文案 + 单实例 + `boot-state.json` + 日志路径统一） | Bridge/Active 全挂时 UI 仍打开并显示降级；无黑框 |
| **P3** | 错误信息产品化 | `assets/js/error-catalog.js` 扩展 + 「详细信息」抽屉 + Bridge/服务类错误接入 | 401/429/网络/Bridge 拒连 均有人话文案，原始错误可展开 |
| **P4** | First-Run Wizard | `assets/js/first-run.js` + 少量接线 | 空库启动即出向导；7 步走完能发第一条消息 |
| **P5** | System Diagnostics | `assets/js/diagnostics.js` + `#page-diagnostics` + boot-state 消费 | 一键检查/修复/导出全部基于真实探测；报告无密钥 |
| **P6** | 零基础图文教程 | `docs/ZERO-BASIS-GUIDE.md` + `#page-guide` 新章节 + `scripts/capture-guide-shots.js` + `annotations.json` | 无假截图；步骤可被非程序员照做 |
| **P7** | Installer 与发行 | Inno Setup 脚本、载荷白名单、快捷方式、卸载、签名流程、`docs/RELEASE.md` | 干净 Windows 上产出 `InternalBeyond-Setup.exe` 并安装成功 |
| **P8** | 端到端验收 | 验收脚本 + 报告 | 见 §12 全部通过 |

---

## 11. 每个 Phase 涉及的文件与风险

### P1 内置 Node Runtime
- **改**：`启动 InternalBeyond.vbs`（node 解析）、`local-services-runner.js`（`IB_NODE` 支持，可选）
- **新增**：`runtime/node/**`、`scripts/update-node-runtime.ps1`、`LICENSES/THIRD-PARTY-NODE.md`
- **风险**：体积 +25–30MB；杀软误报；许可声明遗漏；`.vbs` 中文编码易损（TROUBLESHOOTING T10 已记载 BOM 问题）→ 改 `.vbs` 必须逐字节核对编码

### P2 启动器零门槛化
- **改**：`launch-internal-beyond.js`、`Start Internal Beyond.cmd`（文案/路径）
- **新增**：`boot-state.json` 写入逻辑
- **风险**：改变"服务不健康就不开 UI"是**行为变更**，需同步改 README/架构文档；`test_launcher.js` 断言可能需扩展；单实例锁要避免与"用户故意开两个窗口"冲突（锁的是 launcher，不是页面）

### P3 错误信息产品化
- **改**：`assets/js/error-catalog.js`、`assets/js/bridge.js`（连接失败文案）
- **新增**：前端"详细信息"抽屉组件
- **风险**：`error-catalog.js` 已被 `test_error_catalog.js` 覆盖，扩展类别需同步测试；**不得**削弱 `IBERR.report()` 的 console 原始诊断（TROUBLESHOOTING 依赖它）；其他会话正在改 `communication.js`，接入时注意冲突

### P4 First-Run Wizard
- **改**：`InternalBeyond.html`（script 标签 + 容器）、`assets/js/core.js`（启动钩子）
- **新增**：`assets/js/first-run.js`
- **风险**：**`InternalBeyond.html` 正被另一会话认领**（`session-61898512`），必须等其释放或用 pending 合并；`saveCurrentApi()` 依赖大量 DOM id，适配器要稳；向导不能破坏"已有用户"启动路径（靠 `ibSetupV1Done` 门控）；provider 元数据必须单一来源

### P5 System Diagnostics
- **改**：`InternalBeyond.html`（页面 + 导航）、`internal-beyond-server.js`（`/health` 加只读字段，可选）
- **新增**：`assets/js/diagnostics.js`
- **风险**：导出报告**泄露密钥**是最高危风险 → 必须复用 `safeConfigSnapshot()` + `redact()` 并做导出后自检；"一键修复"若超出真实能力就变假按钮 → 严格限定为"重启服务/重检/测连接"；`navigator.storage.estimate()` 各浏览器差异需降级

### P6 图文教程
- **改**：`InternalBeyond.html`（`#page-guide` 新章节）
- **新增**：`docs/ZERO-BASIS-GUIDE.md`、`scripts/capture-guide-shots.js`、`docs/guide/annotations.json`、`docs/guide/shots/**`
- **风险**：截图脚本依赖本机 Chrome/Edge（既有测试同样如此）；截图目录体积；**绝不能在没有真实截图时放假图**

### P7 Installer 与发行
- **新增**：`installer/InternalBeyond.iss`、`scripts/build-installer.ps1`、`docs/RELEASE.md`
- **改**：`LICENSES/COPYRIGHT-NOTICE.md`（第三方段落）
- **风险**：载荷白名单漏文件 → 装完打不开（必须自动化"安装后冒烟"）；per-user vs per-machine 路径；SmartScreen（未签名）；**许可为 PolyForm Noncommercial，安装包只能免费非商业分发**；卸载误删用户数据

### P8 验收
- **新增**：`docs/ZERO-SETUP-ACCEPTANCE.md`、可选 `test_zero_setup_smoke.js`
- **风险**：需干净环境（无 Node）；真实 API Key 不能进仓库 → 用测试用 key 或本机模型

---

## 12. 最终验收标准

### 12.1 主验收（"交给一个完全不会编程的人，不给任何口头指导"）

在**干净 Windows 10/11 虚拟机**（无 Node、无 npm、无本项目任何文件）上：

1. 把 `InternalBeyond-Setup.exe` 交给测试者，**不做任何口头说明**。
2. 测试者能独立完成安装，桌面出现 InternalBeyond 图标。
3. 双击图标 → 默认浏览器自动打开 IB，**全程无控制台窗口**。
4. 首启向导自动出现，测试者能：选 Provider → 填 Key → 检测/选择模型 → 测试连接成功 → 创建/选择角色 → **成功发出第一条消息并收到回复**。
5. 全程**不出现** `.cmd`、PowerShell、Node、端口号、`ws://`、`localhost` 等字样（除诊断页"详细信息"中可展开的技术细节）。
6. 手动结束 Bridge 进程后：UI 仍可用；出现「本地服务未启动」提示 + 一键重启按钮；点击后 30 秒内恢复，**无需终端**。
7. 诊断页：一键检查给出真实状态；一键修复能恢复服务；导出报告可用，且**报告内不含任何 API Key / token**（用关键字 grep 验证）。
8. 卸载后 `%LOCALAPPDATA%\InternalBeyond` 用户数据默认保留（卸载时明确询问）。

### 12.2 开发者回归门（不得破坏）

- `git clone` 后 `node local-services-runner.js --status` / `--json` 正常。
- `start-local-services.cmd`、`start-bridge-service.cmd`、`start-active-service.cmd`、`启动 InternalBeyond.vbs --debug` 全部可用。
- `node test-all.js --quick` 全绿；`test_launcher.js`、`test_local_services_runner.js` 通过。
- `InternalBeyond.html` 仍可**直接 `file://` 打开**（除 AudioWorklet 类功能降级，与现状一致）。
- Provider 元数据仍只有 `provider-directory.js` 一份（可用 grep 验证无第二份 PROVIDERS 字面量）。
- 未引入 `package.json` / `node_modules` / 构建步骤。

### 12.3 反向验收（"不许做什么"）

- 不出现假按钮、假绿状态、伪造截图。
- 不因方便把 API Key 写进日志/诊断报告。
- 不新增 RBAC / 账号 / 云端依赖 / 遥测上传。
- 不重写 Bridge / Active / 静态服务核心运行时。

---

## 13. 审计中发现的既有缺陷（建议单独修，不混入本改造）

| # | 缺陷 | 证据 | 建议 |
|---|---|---|---|
| B1 | 可选服务失败阻断整个 UI | `launch-internal-beyond.js:198-204` | 纳入 P2（本改造核心） |
| B2 | 日志路径文案与实际不符 | `Start Internal Beyond.cmd:17` vs `launch-internal-beyond.js` `LOG_DIR = ROOT/logs` | 纳入 P2 |
| B3 | 静态服务把整仓（含 `logs/`、`.git/`）对外提供 | `internal-beyond-server.js` `root=__dirname` | P7 用载荷白名单缓解；可选给 server 加 `IB_WEB_ROOT` |
| B4 | Bridge 未连接提示是开发者指令 | `assets/js/bridge.js:680` | 纳入 P3 |
| B5 | 启动器无 Node 版本校验（只校验存在） | `启动 InternalBeyond.vbs` 仅 `where node.exe` | P1 顺带加 `node --version` 下限检查 |
| B6 | 无单实例保护，重复双击可能拉起多个 runner | `launch-internal-beyond.js` 无锁 | P2 |

---

## 14. 待用户决策的开放问题

1. **内置 Node 版本线**：Node 22 LTS 还是 24 LTS？（下限均为 18，实测无更高 API 依赖）
2. **是否购买代码签名证书**：不签名会有一次 SmartScreen 拦截，教程可覆盖，但观感较差。
3. **安装范围**：per-user（免 UAC，推荐）是否可接受？还是必须 per-machine？
4. **诊断页落点**：独立导航页（推荐）还是塞进现有「设置」页？
5. **是否内置浏览器运行时**：当前方案用系统默认浏览器（Win10/11 必有 Edge），**不引入** Electron/WebView2。若要求"绝对一致的外观与行为"，需重新评估（成本大幅上升）。
6. **教程截图管线**：是否接受先交付纯文字版、截图随后由脚本生成？
7. **Vision（Python）组件**：默认不装 / 标记高级可选 / 完全移出安装包？

---

## 15. 下一步

审计到此结束。**未修改任何运行时代码。**
经你确认上述开放问题（尤其 1/2/3/5）后，从 **P1（内置 Node Runtime + 入口解析）** 开始实施，逐 Phase 提交并回归。
