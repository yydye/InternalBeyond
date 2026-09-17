# InternalBeyond · 发布链审计（Release Tooling R1 · 第 0 步，READ-ONLY）

> 阶段：**Release Tooling R1 · InternalBeyond One-Click Release Builder**
> 本文档是第一轮的**只读审计**产出。审计期间**没有修改任何生产文件**；除本文档外，
> 本轮不新增任何跨阶段能力（P23 / Voice / Android / Economy / Memory / Middle Brain /
> Chat / Group Chat / Provider routing / 角色系统 / 支付 一律未触碰）。
>
> 审计基线：`master` @ `3ca6edc`（`P22-21 . freeze Economy v1 contract`），
> 工作树干净度见 §11。

---

## 0. 结论摘要（先读这一段）

| # | 结论 |
|---|---|
| 1 | 发布链**已经存在**且是单命令的：`scripts/build-installer.ps1`。Release Builder 必须是它的 **orchestrator**，不是第二个 build authority。 |
| 2 | **唯一版本源 = 仓库根 `VERSION`**，由 `runtime/product-version.js` 解析。没有第二份产品版本源（§1）。 |
| 3 | **不存在任何自动发布脚本**：`git push` / `git tag` / `gh release` 全是人工（§8、§13）。 |
| 4 | **发现 3 条可产生「假成功」的真实路径**（§10）——其中 2 条是当前 dist 里已经存在的状态，1 条是结构性缺口。 |
| 5 | **发现 2 处 authority 重复，但都不是产品发布权威**：`Economy-v1-release/`（独立策展包，自带 VERSION/checksums 与 verify 工具）与三个**非产品**版本常量（§9）。二者都**不得**被 Release Builder 当成 IB 产品版本源。 |
| 6 | **架构 blocker：无。** 可以继续实现。但 §10 的三条假成功路径必须在 CHECK/VERIFY 里被真实堵住，否则 Builder 只会把问题藏起来。 |
| 7 | GUI runtime 选择经比较后为 **B. 本地 Node + 系统默认浏览器**（§14），**新增依赖 0**，并产出可双击的 `IB-Release-Builder.exe`（§14.3）。 |

---

## 1. canonical version owner

**唯一所有者：`VERSION`（仓库根，单行 `MAJOR.MINOR.PATCH`）。**

**唯一解析器：`runtime/product-version.js`**
- `FILE = path.join(__dirname, '..', 'VERSION')` —— 没有 cwd 假设、没有环境变量查找。
- `parse()` 只接受 `/^\d+\.\d+\.\d+$/`（无 prerelease / build 后缀）。
- `compare()` 是产品内**唯一** semver 比较（U-D4；浏览器被禁止自己比较）。
- `read()` 失败时返回 `{ok:false, version:'0.0.0', source:'fallback'}` —— 是**降级**，
  调用方必须自己决定是否致命。

**所有下游都是派生，不是第二份权威：**

| 消费者 | 派生方式 |
|---|---|
| `installer/InternalBeyond.iss` | `#ifndef AppVersion → #error`；由构建脚本 `/DAppVersion=` 传入（`AppVersion` / `OutputBaseFilename` / `VersionInfoProductVersion` 全部引用它） |
| `scripts/build-installer.ps1` | 第 1 步读 `VERSION`，非法即 `Fail` |
| `runtime/launch-internal-beyond.js` | `boot-state.launcher.product.version` |
| `services/internal-beyond-server.js` | `GET /health` `.version` |
| `assets/js/guide-beginner.js` | 走 `VERSION` 的 `MAJOR.MINOR`（`guideVersion`） |
| `assets/js/diagnostics.js` | 诊断页「版本」与导出报告 |
| `runtime/update-manifest.js` | `unique` URL 构造 + 版本一致性校验 |
| `runtime/update-check.js` | 版本比较（复用 `compare`） |
| `README.md` | **人工**同步 `当前版本 **x.y.z**` —— 由 `release-audit.js` 的 release-claim 闸门兜住（§7.5） |

> **非产品版本常量（**不是**第二版本源，审计确认过用途）**
> - `apps/catalog.json` 的 `"version":"1.0.0"` —— **单个 APP 的目录版本**（coread / cinema）。
> - `services/ib-bridge-service.js` 的 `VERSION = '1.0.0'` —— **Bridge 服务自身版本**（诊断页单独展示）。
> - `services/home-node-service.js` 的 `SERVICE_VERSION = '1.0.0'` —— **Home Node 服务自身版本**。
>
> 三者与产品版本**无耦合**，`docs/CHANGELOG.md` U5-1 已明确登记「本轮一字未动」。
> Release Builder **必须只读 `VERSION`**，不得把这三处纳入一致性等式（那会造出一个假的 conflict）。

---

## 2. canonical build command

**唯一 canonical 构建入口：**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-installer.ps1 `
  -NotesFile docs\release-notes\<version>.md `
  -MinimumVersion 1.0.1
```

（`docs/RELEASE.md` §1；**1.0.1 刻意省略 `-MinimumVersion`**，1.0.2 起写 `1.0.1`。
`-ReleasedAt` 三次发布**都刻意不传**。见 §7.4。）

**脚本内部 9 步（`scripts/build-installer.ps1`，`[CmdletBinding()]` + `trap { Fail }`）：**

| 步 | 名称 | 关键行为 | 失败后果 |
|---|---|---|---|
| 1 | preflight | `VERSION` / `runtime-pin.json` / `.iss` / 必需文件 / `-ReleasedAt` & `-MinimumVersion` 形状 / `Resolve-Iscc` | `Fail`，**不删** staging |
| 2 | bundled runtime gate | `runtime\node\node.exe` 存在 + 元数据一致 + SHA-256 == pin + 可执行 + `--version` + `process.version` + `require` 内置模块 | `Fail`，**不删** staging |
| 3 | staging | `node scripts\release-manifest.js --stage dist\staging`（**白名单**物化），再生成 `ib-payload-manifest.json` | 从这一步起 `stagingOwned = true`，之后任何失败都 `Remove-Staging` |
| 4 | content + secret + release-claim audit | `node scripts\release-audit.js --dir dist\staging --json` | `Fail`（`-SkipAudit` 可跳过，**不推荐**） |
| 5 | compile | `ISCC.exe /DAppVersion=… /DStagingDir=… /DOutputDir=… installer\InternalBeyond.iss`，输出写 `dist\build-compile.log` | `Fail`（原生命令 stderr → PowerShell 终止性错误 → 由 `trap` 捕获同一路径） |
| 6 | hash | .NET `SHA256.Create()`（**刻意不用 `Get-FileHash`**，避免模块路径被裁剪时假失败）→ `dist\SHA256SUMS.txt`（ASCII） | `Fail` |
| 7 | update manifest | 读回 PE `ProductVersion` → `node runtime\update-manifest.js --write dist\update-stable.json` | `Fail` |
| 8 | install audit | **OPT-IN**（`-InstallAudit`）| `Fail`（显式要求时缺脚本也 Fail） |
| 9 | summary | 清理 staging（`-KeepStaging` 可保留）+ 打印人工发布命令 | — |

**关键性质（Builder 必须原样保留）：**
- 退出码语义：**成功 0 / 任何失败非 0**，且失败一定打印 `[FAIL @ <stage>]`。
- 从第 3 步起失败会**删除 `dist\staging`**；preflight / runtime gate 失败**绝不**删除不是本次创建的目录。
- **第 7 步的值全部来自本次构建刚产生的字节**（hash 用第 6 步实测值、size 用文件长度、
  `productVersion` 从 PE 读回），绝不重新输入。
- 第 7 步还有一条**反漂移闸门**：清单 URL 的资产名必须等于本次真正产出的文件名
  （ISCC 的 `OutputBaseFilename` 与 `installerAssetName()` 是两处独立拼写，用真实字节钉死）。

**默认不安装**：第 8 步默认 `Write-Info` 说明「测试预算只允许一次真实安装 smoke」
（`docs/P7-TEST-BUDGET.md`），真实安装需显式 `-InstallAudit`。

---

## 3. canonical installer naming

**唯一命名规则：`InternalBeyond-Setup-<version>.exe`**

- **构建侧唯一拼写点**：`installer/InternalBeyond.iss` 第 86 行
  `OutputBaseFilename={#AppName}-Setup-{#AppVersion}`。
- **契约侧唯一拼写点**：`runtime/update-manifest.js`
  `ASSET_PREFIX='InternalBeyond-Setup-'` + `ASSET_SUFFIX='.exe'` → `installerAssetName(version)`。
- **这两处是刻意独立的两次拼写**，由构建脚本第 7 步的 URL/文件名对账钉在一起（§2）。
- 版本必须从 `VERSION` 流入（`/DAppVersion=`），`{#AppVersion}` 不允许手写。

**Loader Builder 的约束**：artifact 名字**不得**在 Release Builder 里第二次拼写。
必须调用 `runtime/update-manifest.js` 的 `installerAssetName()` / `installerUrl()` / `tagFor()`。

**tag 规则**：`tagFor(version) === 'v' + version`（`TAG_PREFIX='v'`），
且 `selectInstallerAsset()` 要求 `release.tag_name === tagFor(manifest.version)` —— 即 **tag = version**（U3）。

---

## 4. canonical checksum 生成

**唯一算法：SHA-256，小写十六进制。**

| 位置 | 实现 | 写出的文件 |
|---|---|---|
| 构建期 | `Get-Sha256()`（.NET `SHA256.Create()`，逐字节流式） | `dist\SHA256SUMS.txt`（ASCII，`.exe` 行用 `*` 二进制标记） |
| 客户端校验 | `runtime/update-install.js`（下载时边下边算） | 不落盘，比对 `manifest.installer.sha256` |
| 发布复核 | GitHub API `asset.digest` → `sha256:<hex>` | 人工交叉核对（§8） |
| runtime 钉定 | `installer/runtime-pin.json` + `runtime/node/SHA256SUMS` | 内置 `node.exe` 的 SHA-256 |

**`SHA256SUMS.txt` 头部字段**（第 6 步写出）：产品版本、本机构建时刻、
内置 runtime 的 `node <version> (<platform>) sha256 <hash>`、`certutil` 复核提示。

**上游硬规则（`docs/RELEASE.md` §6）**：`SHA256SUMS.txt` 与清单都必须来自
**同一次构建、同一份已核验 exe 的字节**；**不允许**用重建产物替代；上传后 GitHub 的
`digest` **仍须独立交叉核对**，不能因为「应该一样」跳过。

> ⚠️ **注意 `SHA256SUMS.txt` 的信任级别**：它只是**给人看的记录**。客户端**从不读它**。
> 客户端的唯一权威是清单里的 `installer.sha256` + 本地重算。因此 Release Builder
> **不得**把「`SHA256SUMS.txt` 与 exe 一致」当作放行依据 —— 必须**自己重算**（§10.3）。

---

## 5. canonical manifest 生成

**唯一生成器：`runtime/update-manifest.js`**（U1 冻结；零依赖、纯函数、无时钟、无网络、无 fs 副作用）
—— 它同时是**构建侧唯一 URL 构造器**与**客户端唯一校验器**。

**schema（`internalbeyond.update` / `schemaVersion: 1` / `channel: 'stable'`）：**

| 字段 | 必填 | 约束（`validate()` 实测） |
|---|---|---|
| `schema` / `schemaVersion` | ✅ | 必须精确匹配，否则 error |
| `channel` | ✅ | `CHANNELS = ['stable']` —— **只有 Stable** |
| `version` | ✅ | `MAJOR.MINOR.PATCH` |
| `installer.url` | ✅ | https + host ∈ `['github.com']` + `/<owner>/<repo>/releases/download/<tag>/<asset>` + `tag === 'v'+version` + `asset === installerAssetName(version)` + **URL 版本必须等于 `manifest.version`** |
| `installer.sha256` | ✅ | 64 位小写十六进制 |
| `installer.sizeBytes` | ✅ | 整数，且 ∈ `[8 MiB, 512 MiB]`（防截断闸门，非安全控制） |
| `installer.productVersion` | ✅ | `MAJOR.MINOR.PATCH` 且 == `manifest.version` |
| `releasedAt` | 可选 | ISO-8601 UTC；**绝不编造**（构建脚本与 manifest 模块里**没有任何时钟**，有测试守着） |
| `minimumVersion` | 可选 | 只做形状校验；**客户端不据此拒绝安装** |
| `notes` | 可选 | ≤ 4000 字符；含 `<`/`>` 只记 warning；UI 必须 textContent |
| `notesUrl` | 可选 | 必须 https + host ∈ `['github.com']` |

**两条硬性质：**
1. `writeManifest()` **先 validate 再写盘**：不通过的清单**永不落盘** —— 一个看起来全绿的构建
   不可能发布一份坏清单。
2. 未知字段：**客户端容忍**（只记 warning，保证旧客户端不被新字段打死）；
   **构建端拒绝**（CLI 的 `ALLOWED_FLAGS` 检查，拼错字段名当场失败，绝不静默丢字段）。

**当前 dist 清单实测**（只读复核，本轮执行）：
`node -e "validate(JSON.parse(fs.readFileSync('dist/update-stable.json')))"` → `ok: true`，
`errors: []`，`warnings: []`。

---

## 6. canonical updater consumption

```
客户端（安装版）
  GET /__update-check [?force=1]        ← services/internal-beyond-server.js:427
        └─ runtime/update-check.js checkShared()
             primary   https://github.com/yydye/InternalBeyond/releases/latest/download/update-stable.json
             fallback  GET https://api.github.com/repos/yydye/InternalBeyond/releases/latest
                       （仅当 outcome === 'network'）
             → parse → runtime/update-manifest.js validate() → product-version.compare()
             → status ∈ {update-available, up-to-date, no-information}
             → 24h cache（%LOCALAPPDATA%\InternalBeyond\update-check.json；失败绝不缓存）
             → summarize() 投影（不转发 manifest internals）

  POST /__update/start  { version }     ← services/internal-beyond-server.js:486
        └─ runtime/update-install.js
             下载 manifest.installer.url（fallback: 资产 API/CDN）
             四道校验：Content-Length / size / sha256（本地重算）/ PE ProductVersion·FileVersion
             → 落在 {app} 之外 → detached 启动安装器 → 立即退出
  GET  /__update/status                 ← services/internal-beyond-server.js:490
        └─ install.summarizeState(install.readState({}))  ← 状态文件投影，服务端不发明进度
```

**冻结的传输与错误分类**（`runtime/update-transport.js`，全仓唯一一处 `https.request`）：
- 回退门是**一行可审计等式**：`fallbackAllowed(result) === (result.outcome === 'network')`。
  拿到过任何完整响应（404 / 403 / 429 / 非法 JSON / schema 不符 / hash 非法 / 身份不一致 /
  跳转主机不在白名单）都是 **hard failure → `no-information`，绝不换路**。
- 每一跳都校验主机：`github.com`、`api.github.com`、`objects.githubusercontent.com`、
  `release-assets.githubusercontent.com`。
- 匿名只读，**无 token / 无登录 / 无额外配置**。
- `check()` **永不抛异常**；启动链**不引用**它；**启动时 0 次检查**。

**安装器消费的边界（U3 红线）**：固定参数数组 + `shell:false`；清单里一切字段都是**数据**，
不得拼命令行；**载荷绝不进 `{app}`**；安装包**未代码签名**，SHA-256 只能证明
「下载到的字节 == 清单描述的字节」，**不得**描述成发布者身份验证。

**与 Release Builder 的关系**：Builder **只读、只验证**这条链，**不实现第二份**传输、
比较、缓存或状态机。

---

## 7. U1～U5 invariants（Builder 只能复用 / 调用 / 验证，禁止复制定义）

### U1 · 唯一清单生成器 + 客户端解析/校验
- 唯一生成器 + 唯一 URL 构造器 + 唯一校验器：`runtime/update-manifest.js`。
- **build 侧构造 URL，client 侧只校验和解构**（client 自己拼 URL 就会与已发布契约漂移）。
- 测试：`tests/test_update_manifest.js`。

### U2 · 仅 network fallback；API 路由拒绝 draft/prerelease
- `fallbackAllowed() === (outcome === 'network')`。
- `selectManifestAsset()` **必须证明** `draft === false` 且 `prerelease === false`
  —— 缺失算「未证明为假」→ **拒绝**（肯定式检查，不是默认放行）。
- 唯一 semver 比较、24h 缓存、fail-open、单飞。
- 测试：`tests/test_update_check.js`。

### U3 · tag = version；asset name 精确匹配
- `selectInstallerAsset(release, version, sha256)` 要求：
  `draft === false`、`prerelease === false`、`tag_name === 'v'+version`、
  **恰好一个**资产名等于 `installerAssetName(version)`；
  `asset.digest` 存在则必须等于 `sha256:<manifest.sha256>`（**缺失不构成失败**、**畸形构成失败**）。
- 载荷四道校验 + 绝不进 `{app}` + detached spawn 契约。
- 测试：`tests/test_update_install.js`、`tests/test_pe_version.js`。

### U4 · `/__update/status` 契约
- 路径是 `/__update/status`（**斜杠**，U3 注释曾写成 `/__update-status`，U4 第一版照注释写 → 真实浏览器 404；
  现在有测试守着端点名）。
- 只读投影：`{ok, state, active, version, transport, bytes, totalBytes, startedAt, updatedAt, finishedAt, error}`。
- U4 是**唯一**用户可见更新界面，**只渲染**，不重实现任何校验/比较/传输/状态机。

### U5 · 最终发布四等式 / artifact / sha256 / manifest 对账
`docs/CHANGELOG.md` U5-1 冻结，**四等式必须独立于构建输出、直接从磁盘字节重算**：

1. `manifest.installer.sha256` == SHA-256(exe 字节)
2. `manifest.installer.sizeBytes` == 文件长度
3. `manifest.installer.productVersion` == PE `ProductVersion` == `VERSION`
4. `manifest.installer.url` 的**资产名** == 真实产出文件名（且 URL 版本钉死为 `v<version>`）

**外加（同节记录）**：清单自校验 `validate().ok`、`releasedAt` / `minimumVersion` 的缺席或存在与
事实一致、`notes` 与 `notesFile`（去 BOM 后 trim）逐字相等、无未知顶层字段、staging 已清理。

**上传后的第五条对账（§6 硬规则）**：`manifest.installer.sha256` == 已上传 exe asset 的
GitHub `digest`，且 `manifest.version` == tag 去 `v`。

### 与 U5 并列的两道既有闸门（Builder 必须保留，不得放宽）
- **release-claim 闸门**（`release-audit.js` 的 `scanReleaseClaims`，第 4 步）：
  载荷里的 `README.md` 声明的「当前版本」必须等于同一份载荷里的 `VERSION`；
  不得硬编码指向别的版本的安装包名；**锚点消失同样判失败**（fail closed）。
  起因是一次真实漏改：1.0.4 的发行提交没改 README，落地页与**安装包内部**的 README
  都还写着 1.0.3 —— **没有任何检查失败，是人读页面时发现的**。
- **上游署名闸门**（同函数）：README 前 25 行必须有「非官方二次开发版 / unofficial derivative」，
  且必须有 `## 关于本仓库 / About this fork` 小节 —— 这是**许可义务**。
- **secret / 内容闸门**（`SECRET_RULES` + `BINARY_MARKERS`）：11 类凭据正则 + 二进制标记
  （ASCII + UTF-16LE）、开发者路径、邮箱/手机（warn）。

---

## 8. 当前人工步骤（**这就是要被消除的清单**）

按 `docs/RELEASE.md` §1/§2/§6 + `CHANGELOG.md` U5 各次发布记录，一次发行的当前人工步骤是：

| # | 步骤 | 依据 | 可自动化 |
|---|---|---|---|
| 1 | 决定目标版本号 | 人 | 半（Builder 提供，人确认） |
| 2 | 改 `VERSION` | `CHANGELOG` U5-1 | ✅ |
| 3 | 改 `README.md` 的 `当前版本 **x.y.z**`（**唯一手改版本字面量**） | `RELEASE.md` §5.1 | ✅（且有闸门兜住） |
| 4 | 写 `docs/release-notes/<version>.md` | `RELEASE.md` §1 | ❌（人的文案） |
| 5 | 跑 `scripts\build-installer.ps1 -NotesFile … -MinimumVersion 1.0.1` | `RELEASE.md` §1 | ✅ |
| 6 | 复核四等式（**独立于构建输出、从磁盘字节重算**） | `CHANGELOG` U5-1 | ✅ |
| 7 | 复核 dist 三件产物 | `RELEASE.md` §1 | ✅ |
| 8 | `git push master` | `CHANGELOG` U5（1.0.1 记录） | ⛔ **irreversible** |
| 9 | `git tag -a v<version> <HEAD>` + `git push origin v<version>` | 同上；**先 push 后 tag**，绝不依赖 `gh` 默认 HEAD | ⛔ |
| 10 | `gh release create v<version> <exe> <SHA256SUMS.txt> --title … --notes-file …` | `RELEASE.md` §6 | ⛔ |
| 11 | 复核上传后的 asset `digest` / `size`（**独立交叉核对**） | `RELEASE.md` §6 硬规则 | 半（可读，但删除 release 的动作是人） |
| 12 | `gh release upload v<version> dist/update-stable.json`（**LAST**） | `RELEASE.md` §2 | ⛔ |
| 13 | 真实客户端只读复核（`/__update-check?force=1` → `update-available`） | `RELEASE.md` §8 各次发布后实测 | 半（需真实安装实例） |
| 14 | 写 `CHANGELOG` / `HANDOVER` / `RELEASE` §8 记录 | 仓库惯例 | 半（Builder 生成日志骨架） |

> **顺序即契约**：`exe → SHA256SUMS.txt → update-stable.json(LAST)`。
> 上传清单这个动作**本身**就是「进入 Stable 通道」的时刻。反向推论同样重要：
> **不要先把清单传上去**（会让客户端在窗口期内拿到指向尚未存在资产的清单）。

---

## 9. 当前重复 authority

### 9.1 真实存在的重复（**必须显式排除在 Builder 之外**）

| 对象 | 它是什么 | 与 IB 产品发布的关系 | Builder 的态度 |
|---|---|---|---|
| `Economy-v1-release/`（**未跟踪**） | Economy v1 的**独立策展发布包**：自带 `VERSION`（内容 `1.0.5`）、`build-package.js`、`ECONOMY_V1_CHECKSUMS.txt`（152 条，含自身 manifestSha256）、`README.txt` | **不是** Windows 安装包发布链；它是「一个目录形态的策展交付物」，`README.txt` 明确说明它**刻意不含** `InternalBeyond.html` 应用壳，所以它**不能**用 `scripts/build-installer.ps1` 构建 | **只读识别、不参与**。不得把它的 `VERSION` 当作产品版本源，也不得替它做发布 |
| `apps/catalog.json` `version: 1.0.0` | 单个 APP 的目录版本 | 无耦合 | 只读识别，**不纳入一致性等式** |
| `services/ib-bridge-service.js` `VERSION='1.0.0'` | Bridge 服务自身版本 | 无耦合 | 同上 |
| `services/home-node-service.js` `SERVICE_VERSION='1.0.0'` | Home Node 服务自身版本 | 无耦合 | 同上 |
| `installer/runtime-pin.json` + `runtime/node/VERSION` + `runtime/node/SHA256SUMS` | 内置 **Node runtime** 的钉定值（三者必须一致） | 构建期第 2 步的硬闸门，**已经是** canonical | ✅ **复用**（Builder 自己再校验一次更快更早地失败） |

### 9.2 不存在重复的部分（审计确认）

- **没有第二份产品版本源**：全仓仅 `VERSION` 一个文件承载产品版本；
  唯一的另一处人工同步点是 `README.md` 的一句话，且已有机检闸门。
- **没有第二份 manifest 生成器 / 校验器 / URL 构造器**。
- **没有第二份「四等式」定义**：`test_installer_build.js` 与 `CHANGELOG` 记录是**断言**与**记录**，
  业务定义只在 `runtime/update-manifest.js` + 构建脚本第 7 步。
- **没有第二个发布脚本**：不存在 `publish.*` / `release.*ps1` / `deploy.*`。
- **没有 GitHub Actions / CI**：`.github/` 不存在，发布**完全**是本机人工。

---

## 10. 当前可能产生「假成功」的路径（**必须在 CHECK/VERIFY 里堵住**）

> 这三条是本轮审计**最重的发现**。它们都不是「代码 bug」，而是
> **构建能返回 0 而结果与已发布事实不符**的路径。

### 10.1 【结构性】同版本重建 → 覆盖已发布字节，而构建返回 0

`scripts/build-installer.ps1` **不检查**目标 exe 是否已存在、**不检查** tag / release 是否存在、
**不检查** `VERSION` 是否已被发布过。因此：

```
VERSION 仍是 1.0.5（已经发布/已构建）  →  再跑一次构建
  → ISCC 直接覆盖 dist\InternalBeyond-Setup-1.0.5.exe
  → 第 6/7 步产生新的 sha256 / sizeBytes
  → 退出码 0  ← 「成功」
```

**后果**：本地 `dist\` 里的 1.0.5 与**已发布**的 1.0.5 已经不是同一批字节，
而**没有任何东西会报错**。这正是 `docs/RELEASE.md` §6 那句
「不允许用重新构建的产物替代原发布字节」所防范的事故，但**当时靠人守**。

**Builder 的处置**：CHECK 必须把「目标版本 == 当前 `VERSION`」判为
**需要显式确认的二次构建**（默认 **BLOCKED**），并且在 VERIFY/SEAL 里
把「已发布清单」与「本地新产物」做**对账**：同名版本而 `sha256` 不同 → **BLOCKED**。

### 10.2 【实测存在】当前 dist 的清单无法由 canonical 构建路径复现

对当前 `dist/update-stable.json`（1.0.5）的实测：

| 字段 | 当前值 | canonical `build-installer.ps1` 默认会产出 |
|---|---|---|
| `releasedAt` | `"2026-09-15T00:00:00Z"`（**UTC 零点整**） | **省略**（无 `-ReleasedAt`；`RELEASE.md` §4 明确「构建刚结束时永远属于确定不了」，1.0.1/1.0.2/1.0.3/1.0.4 **四次都刻意省略**） |
| `minimumVersion` | `"1.0.0"` | `"1.0.1"`（`RELEASE.md` §1：1.0.2 起写 `1.0.1`；写 `1.0.0` 被 CHANGELOG U5-1 明确判为「一句不成立的产品承诺」） |
| `notes` | 4830 B 的 1.0.5 更新说明 | 与 `docs/release-notes/1.0.5.md` 同源 |

**清单本身是 schema-valid 的**（`validate().ok = true`，四等式我也复核过：
`sha256` / `sizeBytes` / PE `ProductVersion` / URL 资产名**全部与实际 exe 字节一致**）。
所以这不是「坏清单」，而是：

> **当前 dist 的清单是经 canonical 模块重新生成并附加了两个非默认字段的产物，
> 而这一步没有任何日志记录（`dist/` 里没有 `release-<version>.log`，
> `docs/CHANGELOG.md` / `RELEASE.md` 全文检索 **0 处**提到 `v1.0.5` / `1.0.5` 的发布）。**

**Builder 的处置**：不假定、不猜测。SEAL 必须**显式记录**它写进清单的每一个可选字段的**来源**
（默认省略；`releasedAt` 只在「本次真的发布了」时写入，且 Builder 会把「发布时刻」与
「构建时刻」严格区分），并且**把清单的可选字段与最终发布事实的差异打印出来让人看见**。
**不得**为了「让 1.0.5 的清单看起来和 1.0.4 一样」去改契约或回写历史。

### 10.3 【结构性】`SHA256SUMS.txt` 可能陈旧而无人察觉

`SHA256SUMS.txt` 是**给人看的记录**，客户端**从不读它**。
构建脚本第 6 步重写它，但如果第 6 步成功、第 7 步失败：

```
dist/  ← 新 exe + 新 SHA256SUMS.txt（都对）
dist/update-stable.json  ← 上一次构建的旧清单（指向旧 sha256）
```

**此时 dist 处于「不一致但没有任何东西报错」的状态**（`SHA256SUMS` 与 exe 一致，
清单与 exe 不一致）。**发布阻断仍然成立**（因为清单是最后上传的那个，且
`RELEASE.md` §6 要求三条硬规则），但**本地状态已经开始说谎**。

**Builder 的处置**：VERIFY 必须**从最终 artifact 重新计算 SHA-256**
（**禁止读旧 `SHA256SUMS.txt` 当依据**），三方（exe / `SHA256SUMS.txt` / manifest）对账；
SEAL 完成后再**从磁盘重新读取**做最终三方对账（禁止拿内存中的旧对象宣布成功）。

### 10.4 其它已识别的「假成功」面

| 面 | 现状 | Builder 的处置 |
|---|---|---|
| build 退出码 0 ⇒ 假设 exe 存在 | 构建脚本第 5 步**已经**用 `Test-Path` 兜住 | Builder **不得**退化成「命令返回 0 所以假设 EXE 存在」；必须做真实 artifact discovery |
| 文件名不匹配 | 第 7 步的 URL/文件名对账已兜住 | 复用，并在 VERIFY 再核一次 |
| 陈旧 staging | 第 3 步起失败必删；成功必在 summary 删 | SEAL 前检查 `dist\staging` 不存在 |
| `-SkipAudit` | 存在，会静默降级（只打 WARN） | Builder **不提供** `-SkipAudit` 通道；不暴露、不透传 |
| `-SkipInstallAudit` | 存在（现在是默认行为） | 不作为放行依据 |
| warn 当 success | 构建脚本把 warn 明确标注为「人工复核，不阻断」 | Builder 的 CHECK/VERIFY **状态色**必须区分「error 阻断」与「warn 需人读」，且**永不**把 warn 计入 ok |
| 「基本成功 / 应该没问题」措辞 | — | Builder 顶级状态**只有** `BLOCKED` / `READY` / `PUBLISHED` |
| 未知状态 | — | 任何无法确定的状态一律 **BLOCKED**（fail closed） |

---

## 11. dist 当前治理方式

- **`dist/` 不在版本库**：`.gitignore:31` `dist/`（`git check-ignore` 实测命中）。
- **当前实际内容**（只读实测）：

| 项 | 大小 | mtime |
|---|---|---|
| `InternalBeyond-Setup-1.0.1.exe` … `1.0.4.exe` | 50.8–51.8 MB 各一 | 2026-09-10 ~ 09-11 |
| `InternalBeyond-Setup-1.0.5.exe` | 52,171,058 B | **2026-09-15 11:48:36** |
| `SHA256SUMS.txt` | 406 B | 2026-09-15 11:48:37 |
| `update-stable.json` | 5,354 B | 2026-09-15 11:48:38 |
| `build-compile.log` | 27,266 B | 2026-09-15 11:48:36 |
| `android/` | 目录 | 2026-09-11 |

  → **5 个历史版本安装包平铺在 dist 根**，只有最新的三件产物构成「当前发行集」。
  没有任何标记说明哪一份是「待发布的」，也没有 `release-<version>.log`。
- **没有任何脚本读取 `dist/` 目录布局**（审计确认：客户端只读 GitHub Release；
  `release-manifest.js` 的 `stage()` 只在写入时**清理并重建** `dist/staging`）。
  → 所以 **`dist/archive/<old-version>/` 归档是安全的**，但必须：
  1. 只移动**非当前版本**的 exe 与其附属产物；
  2. **绝不**移动当前版本的 `update-stable.json` / `SHA256SUMS.txt` / exe；
  3. 有「布局依赖」闸门：SEAL 前扫描仓库，若发现任何代码引用 `dist/` 的扁平布局，则**不移动**。

- **工作树状态（审计时刻实测）**：`git status --porcelain` = **10 条**：
  - ` D P11-3D.md`（**未跟踪/已删除的怪异状态**：根目录的 `P11-3D.md` 被删、`docs/P11-3D.md` 是未跟踪的新文件）
  - 未跟踪：`.dsh-research/`、`Economy-v1-release/`、`InternalBeyond-Economy-v1.tar.gz`(+`.sha256`)、
    `docs/ECONOMY_V1_RELEASE_MANIFEST.md`、`docs/MOBILE_HOME_NODE_AUDIT.md`、
    `docs/Mobile Master Roadmap v1.md`、`docs/P11-3D.md`、`docs/P22-0-ECONOMY-AUDIT.md`
  - **`origin/master` 落后 118 个提交**（`git rev-list --left-right --count origin/master...master` → `0  118`）
  - 本地 tag 只有 `v1.0.0`–`v1.0.4`；**没有 `v1.0.5`**，`git log` 亦**全库 0 处** `v1.0.5` 记录
  - **`VERSION` = 1.0.5**，其最后一次变更是 `a477fad`（2026-09-15 11:26:22，`release: InternalBeyond 1.0.5`）

---

## 12. 哪些步骤可以安全自动化

| 步骤 | 可自动化 | 理由 |
|---|---|---|
| 读当前版本 / 校验版本形状 | ✅ safe | 纯只读 |
| 目标版本合法性 / 单调递增（`compare() > 0`） | ✅ safe | 纯函数，已有唯一比较器 |
| 全部 version source 一致性 | ✅ safe | 只读；**范围限定为产品版本**（§9.1） |
| Git 状态检查（脏、ahead/behind、tag 是否已存在） | ✅ safe | 只读 |
| U1～U5 所需文件存在性 | ✅ safe | 只读 |
| `update-stable.json` 可解析 + `validate()` | ✅ safe | 复用 canonical validator |
| dist 可写 / ISCC 可用 / 内置 runtime pin 一致 | ✅ safe | 只读 + 一次 `node --version` |
| Dry Run（版本计划 / 将执行的命令 / 将改的文件 / 将移动的旧文件 / 将执行的 Publish 动作） | ✅ safe | **零副作用**，必须真零 |
| 改 `VERSION` | ✅ 可自动化，**但必须可恢复** | 见 §11、§15 |
| 改 `README.md` 的版本字面量 | ✅ 可自动化，**但被闸门兜住** | `release-audit` 的 release-claim 会独立复核 |
| 调用 canonical build（一次） | ✅ 可自动化 | 唯一 build authority |
| 从磁盘重算 SHA-256 / 读 PE ProductVersion | ✅ safe | 四等式的基础 |
| 重新生成 / 校验 manifest（canonical generator） | ✅ safe | 复用，不复制定义 |
| 保存日志 / 生成 `release-<version>.log` | ✅ safe | 本地文件 |
| dist 归档旧版本 | ✅ 有条件 safe | 需布局依赖闸门（§11） |
| `git add` + `git commit`（发行提交） | ⚠️ 半自动 | 只允许**精确路径**，不允许 `git add -A`；失败恢复**不得**用 `git reset --hard` |
| `git push` / `git tag -a` / `git push origin <tag>` | ⛔ **irreversible publish** | §13 |
| `gh release create` / `gh release upload` | ⛔ **irreversible publish** | §13 |
| 删除 release（发布后对账失败时的唯一正确动作） | ⛔ 人工 | §13 |

---

## 13. 哪些动作属于 irreversible publish

**定义**：一旦执行就**无法用本地文件恢复**、会改变外部世界（远端仓库 / GitHub Releases /
Stable 更新通道 / 用户客户端行为）的动作。

| 动作 | 为什么不可逆 |
|---|---|
| `git push origin master` | 远端历史公开可见（仓库 **public**，`DECISIONS.md` §117 事实更正）；不能真正撤回 |
| `git tag -a v<version>` + `git push origin v<version>` | tag 是 `selectManifestAsset()` / `selectInstallerAsset()` 的身份锚点（`tag === 'v'+version`）；**tag 不可变**，改了等于换了发布身份 |
| `gh release create` | 创建 release **实体**；Latest 语义立即变化 |
| 上传安装包 / `SHA256SUMS.txt` 资产 | 资产一旦公开即被 CDN 缓存；**不得**用重建产物替换 |
| **上传 `update-stable.json`** | **这一刻就是「进入 Stable 通道」**：所有 1.0.1+ 客户端会开始看到这个版本。上传顺序中的最后一个动作，也是**唯一**真正对用户生效的动作 |
| 删除 release 重来 | 唯一允许的「修正」手段（`RELEASE.md` §6：「三条中任何一条不成立：删掉 release 重来，不要就地改清单」），但它本身也是**不可逆的外部操作** |

**Builder 的硬要求**：Publish 必须**独立按钮 + 显式确认 + 展示即将执行的动作**，
**默认不执行**；失败时**保留已 Seal 的本地产物**，**绝不因为上传失败而重新 build**。

---

## 14. Release Builder 的最小架构建议

### 14.1 定位（一句话）

> **Release Builder = `scripts\build-installer.ps1` + `runtime/update-manifest.js` +
> `scripts/release-audit.js` 的 orchestrator。它自己不产生任何发布真相。**

### 14.2 目录与职责

```
tools/release-builder/
  server.js                 ← localhost HTTP 服务 + 静态 GUI + 一次性 boot token（唯一 Node 入口）
  lib/
    canonical.js            ← canonical adapter：唯一允许 require 仓库真源的地方
                              （product-version / update-manifest / release-manifest /
                                release-audit / pe-version / update-check）
    plan.js                 ← 纯规划：版本计划 / artifact 名 / 频道 / 阶段机 / fail-closed 判定（零 I/O）
    check.js                ← CHECK：真检查，逐项 {expected, actual, evidence}
    build.js                ← BUILD：调用 canonical build，流式日志，exit code，artifact discovery
    verify.js               ← VERIFY：四等式（从磁盘重算）+ U1–U5 + 三方对账
    seal.js                 ← SEAL：dist 治理 + release log + 最终重读对账
    publish.js              ← PUBLISH：只做「展示 + 逐条确认 + 执行已审计的 gh/git 命令」；默认不执行
    log.js                  ← 结构化 release log + **secret redaction**（白名单字段）
    state.js                ← 状态机：BLOCKED / READY / PUBLISHED；dry-run 开关
  public/                   ← GUI（index.html + app.js + builder.css）
  launcher/                 ← IB-Release-Builder.exe 的 C#/.NET Framework 启动器源码
  build.js                  ← 构建 Builder 自身（csc.exe + 仓库内置 node 运行时）
  README.md
tests/                      ← 见 §14.6（登记进 tests/test-all.js 的 static 组）
```

### 14.3 GUI 技术选择（**对比后选 B，理由实测**）

| 方案 | 新增依赖 | 能否产出独立 EXE | 结论 |
|---|---|---|---|
| **A. 复用现有 Electron** | 需要 Electron 运行时 | 是（但体积 200 MB+） | ❌ 仓库**没有** Electron；`node_modules` 不存在；为一个本地发布工具引入 Electron **违背项目已冻结的决策**（Zero-Setup 发行决策：不引入 Electron/Tauri/WebView2，用系统默认浏览器） |
| **B. Node 本地服务 + 系统默认浏览器** | **0** | **是**（见下） | ✅ **选定**：产品自己的发行机制（Zero-Setup Update 决策）就是「Node 做真源，浏览器只渲染」；Builder 复用它，**新增依赖 0** |
| **C. PowerShell/.NET launcher + WebView2** | WebView2 Runtime（本机实测已装 `153.0.4234.32`，但**用户机器不保证**） | 是 | ❌ 引入一个**运行时前置条件**，而正式安装包的产品原则是「用户无需预装任何东西」；且必须有 C# 编译或 `dotnet`（本机有，但增加工具链面） |
| **D. 其它已在项目依赖中的方案** | — | — | ❌ 项目**零运行时依赖**（全仓无根 `package.json` / 无 `node_modules`），没有可用方案 |

**B 的 EXE 产出方式（新增依赖 0、无自我发布循环）：**

```
tools/IB-Release-Builder.exe        ← csc.exe 编译的原生 .NET Framework 启动器（~10 KB）
        │  ① 在自己所在目录 / 仓库内定位 node.exe（优先 runtime\node\node.exe，其次 PATH 上的 node）
        │  ② spawn(node.exe, [server.js, --root <repo>], {shell:false, stdio:'inherit'})
        │  ③ 等 Node 打印 `RELEASE-BUILDER-URL http://127.0.0.1:<port>/?t=<token>` 后
        │     用 cmd.exe /c start "" <url> 打开系统默认浏览器（沿用它处已验证的启动方式）
        └─ ④ 退出时清理子进程
```

- `csc.exe` 实测存在：`C:\WINDOWS\Microsoft.NET\Framework64\v4.0.30319\csc.exe`（Zero-Setup Windows 自带，**无需安装**）。
- 也兼容 `dotnet build`（本机有 `dotnet.exe`）作为替代工具链。
- **不使用** Inno Setup 给小工具做安装器（多一个环节、多一个卸载面）。
- **不使用** Node SEA / postject：本机 `node -e "require('module').isSEA"` → `undefined`，
  且需要 postject 注入 blob（新增第三方工具）。C# 启动器零新增依赖。

### 14.4 五阶段与状态机

```
CHECK → BUILD → VERIFY → SEAL → [STOP: READY] → PUBLISH(独立按钮) → PUBLISHED
```

- 一键主流程 = CHECK → BUILD → VERIFY → SEAL → **STOP**（RELEASE READY ≠ PUBLISHED）。
- 顶级状态**只有** `BLOCKED` / `READY` / `PUBLISHED`。
- **CHECK 失败 → 不 BUILD；BUILD 非 0 → 不 VERIFY、不 SEAL、不碰 stable manifest。**
- **VERIFY 非全绿 → 不允许 SEAL。**
- Publish 失败**保留**已 Seal 产物，**绝不**重新 build。
- **Dry Run**：只跑 CHECK + 规划输出（版本计划 / 将调用的 build path / 将生成的 artifact 名 /
  将更新的文件 / 将移动的旧文件 / 将执行的 Publish 动作），**零副作用**。

### 14.5 Canonical adapter 边界（**防「第二权威」的机制**）

`lib/canonical.js` 是**唯一**允许 `require` 仓库真源的文件，且只允许 require 这些：

```
runtime/product-version.js     → read / compare / parse（唯一版本源与唯一比较器）
runtime/update-manifest.js     → installerAssetName / installerUrl / tagFor / validate / serialize
runtime/pe-version.js          → 读 exe 的 PE ProductVersion / FileVersion
scripts/release-manifest.js    → resolve（白名单核对）
scripts/release-audit.js       → scanDirectory（载荷审计，供 VERIFY 复用）
runtime/update-check.js        → check（**只在 dry-run/只读频道复核时调用，绝不写缓存进 {app}**）
```

**禁止清单（写进 README 与测试）：**
- 禁止在 Builder 里重新拼 `InternalBeyond-Setup-<v>.exe` / `v<version>` / `releases/download/...`。
- 禁止在 Builder 里写第二份「四等式」业务定义（必须**调用** `validate()` 与 `installerUrl()`/`installerAssetName()` 做比对）。
- 禁止在 Builder 里写第二份 semver 比较（必须用 `productVersion.compare`）。
- 禁止在 Builder 里写第二份 secret 扫描词表（必须用 `release-audit.js`）。
- 禁止在 Builder 里实现 transport / 缓存 / 安装状态机。

> 这些禁令由**测试**执行（源码结构断言：Builder 里不得出现 `InternalBeyond-Setup-` 字面量、
> 不得出现 semver 比较正则、不得 `require('https')`）—— 与仓库既有的
> 「去注释后源码结构断言」风格一致（参见 ARCHITECTURE.md §13 的 U3 断言做法）。

### 14.6 测试计划（按用户 §12 的四类）

- **A. Pure planning tests**（零 I/O）：版本计划、artifact 命名、频道、状态机、fail-closed 矩阵、dry-run 计划。
- **B. Fixture tests**（临时目录）：假成功构建 / 假失败构建 / artifact 缺失 / 文件名错 /
  sha 错 / manifest 错 / 脏仓库 / 非法版本 / 陈旧 checksum。
- **C. Integration**：在临时目录里放**完整 canonical fixture 仓库**（真实 `lib/` + 真实
  白名单 + 真实的假 `build-installer.ps1` stub 产出合成 exe），跑完整
  CHECK→BUILD→VERIFY→SEAL，**不污染真实 `dist/`**，结束后**删除临时目录**。
- **D. Counterproof**：主动破坏 version / artifact name / SHA / manifest / build exit code /
  U1–U5 validator 结果，**逐个确认能把 `READY` 打回 `BLOCKED`**。

**测试预算**：遵守 `docs/P7-TEST-BUDGET.md` —— 全部测试为**纯 Node / 静态 / 隔离临时目录**，
**不安装、不启动真实客户端、不开浏览器（`browserOpens === 0`）、不联网**。

### 14.7 日志与 secret 红线

每次 Release 生成独立 `dist/release-<version>.log`（结构化），**字段白名单构造**：
timestamp / repo commit / source version / target version / channel / CHECK 逐项结果 /
build command / build exit code / artifact path / artifact bytes / SHA256 / manifest 值 /
U1–U5 逐项 / Seal 结果 / Publish 结果（若执行）。

**禁止**：记录 API Key / token / secret；dump 完整环境变量；
**若某命令输出可能含 secret 则先 redaction**（复用 `release-audit.js` 的 `SECRET_RULES`
作为脱敏词表 —— **不新建第二套词表**）。

---

## 15. 审计结论与放行判定

| 问题 | 结论 |
|---|---|
| 是否存在发布 authority 冲突？ | **不存在产品级冲突。** 两处「看似第二权威」的东西（`Economy-v1-release/`、三个非产品版本常量）经审计确认**不是** IB 产品发布权威，Builder 明确排除。 |
| 是否存在架构 blocker？ | **无。** 可以继续实现。 |
| 是否必须先在 GUI 里「遮住」某些冲突？ | **不需要，也不允许。** §10 的三条假成功路径将被 CHECK/VERIFY 以 **BLOCKED** 暴露出来（而非隐藏）。 |
| 复用还是新建？ | **完全复用**：Builder 只调用 `build-installer.ps1` + `update-manifest.js` + `release-audit.js` + `release-manifest.js` + `pe-version.js` + `product-version.js`。 |
| 本轮对生产文件的修改 | **0**（仅新增本文档）。 |

### 15.1 需要用户知道的两个**事实**（不是需要批准的动作，但影响下一次发布）

1. **`dist\` 里的 1.0.5 与仓库当前的 1.0.5 状态是「构建于 `19485f8`」**，
   其后（`36db789` 起）到 `3ca6edc` 有 **118 个提交**（含整套 Economy v1 P22 系列与
   `36db789 fix(release): make the payload manifests and the build hash gate agree`）
   **都不在**那个已构建的 1.0.5 里。
   → 如果目标是发 1.0.5，`dist` 里这份**不能**用（它不是当前 HEAD 的产物）；
   如果目标是发 1.0.6+，则 `VERSION` 必须 bump，而 **bump 之后 `README.md` 的
   `当前版本 **1.0.5**` 必须同一次改掉**，否则 release-claim 闸门会在第 4 步失败
   （**这是闸门正常工作，不是 bug**）。
2. **当前 dist 的 `update-stable.json` 带有 `releasedAt: 2026-09-15T00:00:00Z` 与
   `minimumVersion: 1.0.0`**，这两个值**都不是** canonical 默认路径会产出的值，
   且**没有任何日志记录**它们是怎么写进去的。Builder 不会去「修正」历史，
   但会把这类差异**显式打印**（Publish 前的人工确认清单里含「清单可选项及其来源」）。

---

## 16. 实现记录（本轮后续，供审计闭环）

审计判定「无架构 blocker」后，本轮按本文档 §14 的建议实现了
`tools/release-builder/`（源码、GUI、编排核心、canonical 适配器、测试、README、构建脚本），
并产出可双击的 `tools\IB-Release-Builder.exe`。实现过程中**修正了三处审计结论的精度**，
如实记录如下（审计是测量，不是预言）：

1. **§10.1 的「同版本重建」需要区分「平移」与「降级」**：`target < current` 必须无条件是
   blocker（会向客户端提供降级），而 `target == current` 是「需要显式确认的重建」，
   不是类别上的非法。实现按这条精度落地（`lib/plan.js` 的 `version-plan`）。
2. **`warn` 的语义收紧了**：审计把「Git 状态不符合发布要求」整体列为 fail-closed 条件，
   但真实仓库长期存在未跟踪文件（本仓库当前就有若干），把它当 blocker 会让工具
   无法使用。实现的口径是：**blocker 阻断、warning 必须被人读到**，
   且**顶级状态不会因为 warning 而变成干净的通过**；未跟踪/已修改文件逐条列出。
   这没有放宽任何 canonical 闸门（第 4 步的审计、第 7 步的对账一字未动）。
3. **`dist` 归档新增了一条审计没写的保护**：归档旧安装包时，
   **本次构建开始时的 `VERSION` 所对应的产物永不归档**。理由正是审计 §6 引用的
   `docs/RELEASE.md` §6 硬规则：那些字节可能已经是已发布版本的那一份，
   而规则禁止用重建产物替代它。实测：真实 `dist/` 的 1.0.1–1.0.4 进入归档计划，
   **1.0.5 被保护留在原地**。
4. **内置运行时探针从「阻断」下调为「警告」**：审计把「canonical builder 可用 / 真实依赖可用」
   列为 CHECK 项。实现时区分了两件事 —— **文件不在**（`runtime\node\node.exe` 缺失）仍然是
   **blocker**；**文件在、字节与 `runtime-pin.json` 一致、但它没有报告钉定版本**
   （开发树、或测试 fixture 里的合成 PE）只报 **warning**，因为这条的硬闸门本来就是
   canonical 第 2 步（它还会核对 `runtime\node\VERSION` 与 `SHA256SUMS`，失败即整个构建失败），
   而 Release Builder 既不能修也不能替换一个运行时 —— 在那里阻断只会让工具无法使用，
   却不会让任何一个坏版本更容易发布。

### 16.1 本轮在生产文件上的修改清单（审计之后）

| 文件 | 修改 | 性质 |
|---|---|---|
| `.gitignore` | 追加 3 条：`tools/IB-Release-Builder.exe`、`tools/release-builder-runtime/`、`tools/release-builder/.dry-run/` | 仅忽略生成物 |
| `tests/test-all.js` | `SCRIPT_DIRS` 增加三个 Release Builder 套件的目录映射；static 组登记这三个套件 | 测试登记 |
| `docs/RELEASE_PIPELINE_AUDIT.md` | 新增（本文档，含本节） | 文档 |
| `tools/release-builder/**` | 新增 | 新工具源码 |
| **发布契约本身**（`runtime/update-manifest.js`、`scripts/build-installer.ps1`、`scripts/release-audit.js`、`scripts/release-manifest.js`、`installer/InternalBeyond.iss`） | **一字未改** | — |

**U1–U5 一条都没有放宽**，`runtime/` 与 `scripts/` 下的既有文件全部保持原字节。

