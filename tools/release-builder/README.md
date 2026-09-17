# InternalBeyond Release Builder（Release Tooling R2）

> 一个本地发布编排器：**AI 写代码，它负责发布。**
>
> 它**不产生任何发布真相**。唯一的版本源、唯一的清单生成器/校验器、唯一的构建脚本、
> 唯一的载荷审计，仍然是仓库里的那一份 —— 它只负责**按正确顺序、在正确的前提下、
> 用正确的字节**把它们串起来，并在任何一项对不上时**停下来**。
>
> R2 只改**表现层**：把界面从「调试面板」收成一个不需要懂流水线的人也能用的发布工具。
> 唯一新增的写入口是 `docs/release-notes/<版本>.md` 的编辑器（见 [docs/RELEASE_BUILDER_GUI.md](../../docs/RELEASE_BUILDER_GUI.md)）。
> 发布权威、阶段闸门、PUBLISH 确认链一字未动。

---

## 1. 它解决什么

以前发一次版本要人工做 14 步（见 [docs/RELEASE_PIPELINE_AUDIT.md](../../docs/RELEASE_PIPELINE_AUDIT.md) §8）：
改 `VERSION`、改 README、写 release notes、跑构建、复核四等式、比对文件名、算 SHA256、
改清单、push、tag、`gh release create`、核对 digest、最后上传清单……

现在：**双击 `tools\IB-Release-Builder.exe` → 输入目标版本 → 点「构建 Release」→ 看到
`RELEASE READY`**。真正不可逆的那一步（push / tag / release / upload）是**另一个按钮**，
默认不执行。

主界面只回答八个问题：当前版本、目标版本、Git 状态、工作区状态、Release Notes 状态、
以及 CHECK / BUILD / VERIFY / SEAL 各自到哪一步了。失败一律翻译成人能直接照做的一句话
（「版本号没有增加」「工作区还有未提交的修改」「缺少 1.0.6 的 Release Notes」
「安装包构建失败」「SHA256 校验失败」「GitHub tag 已存在」），原始证据放在同一条的
「原始证据」里。几十行终端输出永远只在收起的「详细日志」区里。

界面的设计约束、每个元素的位置、以及在 1280×800 / 1440×900 / 1920×1080 与 100% / 125%
缩放下的实测结果，见 [docs/RELEASE_BUILDER_GUI.md](../../docs/RELEASE_BUILDER_GUI.md)。

---

## 2. 怎么运行

```
双击  tools\IB-Release-Builder.exe
```

它会：

1. 用**仓库自带的** `runtime\node\node.exe`（内置运行时，已由发行契约钉定 SHA-256）
   启动一个**只监听 127.0.0.1** 的本地服务；
2. 用系统默认浏览器打开界面；
3. 关闭那个控制台窗口即停止。

不需要装任何东西，不需要 PowerShell，不需要 npm，不需要 Electron/WebView2。

**它只开浏览器这一件事是可关的**：设 `IB_RELEASE_NO_BROWSER=1` 后 EXE 变成纯服务宿主，
只在控制台打印地址（无人值守验证就是靠这个，见 §7 的 exe 套件）。
配套的 `IB_RELEASE_PORT=<端口>` 可以固定端口，`IB_NODE=<node.exe>` 可以覆盖运行时解析。

### 界面上有什么

| 位置 | 内容 |
|---|---|
| 顶部 | `InternalBeyond / Release Builder`、`当前版本 1.0.5 → 目标版本 1.0.6`、通道、总状态 |
| 流程条 | 检查 ↓ 构建 ↓ 验证 ↓ 封装，四个阶段各自的状态；失败阶段显示具体原因 |
| 下方分隔 | 发布（到 GitHub）—— 与上面四步分开，永不自动执行 |
| 左侧卡片 | 发行状态、当前版本、目标版本、目标产物、Git 状态、工作区、Release Notes（含「编辑发行说明」）、构建耗时 |
| 右侧 | 需要处理的问题：每条一句话 + 「怎么办」 |
| 构建成功后 | `RELEASE READY`、最终 EXE 文件名、文件大小、SHA256（可复制）、update-stable.json 状态、SHA256SUMS 状态、三方对账、构建耗时、产物目录 |
| 底部 | 构建 Release / 检查 / 打开 dist / 编辑发行说明 / 预演（零副作用）/ 取消 / 重置 |
| 最底 | 「详细日志」（默认收起）：全部条目、真实执行的命令、导出与复制 |

### 从源码构建 EXE

```powershell
node tools\release-builder\build.js          # 生成 tools\IB-Release-Builder.exe + tools\release-builder-runtime\
node tools\release-builder\build.js --check  # 只检查工具链是否可用，不写任何文件
```

用的是 Windows 自带的 .NET Framework 编译器（`csc.exe`，无需安装）。
**不存在循环依赖**：Release Builder 由这个脚本构建，而构建 InternalBeyond 从来不需要它。

`tools\release-builder-runtime\` 是工具的**构建产物副本**（供脱离仓库单独分发时使用），
和 `dist\` 同类：`lib/seal.js` 的布局依赖闸门把它视为产物而不是产品代码 —— 否则工具会
在自己的输出上失败于自己的闸门。

### 直接跑（不构建 EXE，开发时用）

```powershell
node tools\release-builder\server.js --open
# 或者干脆只跑核心逻辑：
node tools\release-builder\tests\test_release_builder_plan.js
```

---

## 3. 五个阶段

| 阶段 | 谁在做 | 关键性质 |
|---|---|---|
| **CHECK** | `lib/check.js` | 每一项都给 **期望值 / 实际值 / 证据文件**；发现冲突即 `RELEASE BLOCKED`；**从不替用户「修好」未知状态** |
| **BUILD** | `lib/build.js` | 只调用 canonical `scripts\build-installer.ps1`（唯一构建权威）；流式日志；记录真实命令与退出码；**退出码 0 不等于产物存在**（有独立的 artifact discovery） |
| **VERIFY** | `lib/verify.js` | 从**最终产物的字节**重算四等式与 U1–U5；**绝不信任旧的 `SHA256SUMS.txt`**；不复制任何业务定义，全部调用 canonical 模块 |
| **SEAL** | `lib/seal.js` | dist 治理（先证明没人依赖扁平布局才归档旧版本）、写发行日志、**完成后再从磁盘重读三件产物做三方对账** |
| **PUBLISH** | `lib/publish.js` | **与 Build/Seal 分权**，单独按钮、逐条列出将执行的动作、必须显式确认；确认串绑定在产物指纹上；失败即停止且**绝不重新 build** |

一键流程是：

```
CHECK → BUILD → VERIFY → SEAL → 停          （到这里是 RELEASE READY，不是 PUBLISHED）
```

真正的发布要再点一次：

```
PUBLISH → git commit → git push → git tag → git push <tag>
        → gh release create <exe> <SHA256SUMS.txt>
        → gh release upload <tag> update-stable.json   ← LAST：这一刻才进入 Stable 通道
```

---

## 4. 顶级状态只有三个

| 状态 | 含义 |
|---|---|
| `BLOCKED` | 有任何一项不成立。**未知状态一律算 BLOCKED。** |
| `READY` | SEAL 成功，**尚未发布**。 |
| `PUBLISHED` | PUBLISH 真正完成。 |

不允许出现「基本成功」「应该没问题」；warning 永远不会被算成 success。

---

## 5. 它绝不会做的事

- 不会重新发明 Electron Builder 配置或安装包命令（只调用 canonical 构建）。
- 不会复制第二份版本源、第二份清单生成器、第二份 semver 比较、第二份四等式、第二份密钥词表。
- 不会自动 push / tag / create release / upload（没有任何代码路径可以在未确认时走到那里）。
- 不会因为上传失败而重新 build。
- 不会 `git reset --hard`；版本提升失败时只还原**事务记录过的那几个文件**。
- 不会把 secret 写进日志（每条日志在入库前经过脱敏，包括命令参数数组）。
- 不会在 Dry Run 里写任何东西。

这些都有测试守着，见 §7。

---

## 6. 日志

每次发行生成 `<repo>\dist\release-<版本>.log`（人读）与 `release-<版本>.jsonl`（机读）。

日志里一定有：时间戳、repo commit、源版本、目标版本、通道、CHECK 逐项结果、真实构建命令、
退出码、产物路径/字节数/SHA256、清单实际值、U1–U5 逐项、SEAL 三方对账、PUBLISH 结果。
日志里一定没有：API Key、token、secret、完整环境变量（若子进程输出里出现，先脱敏再记录）。

---

## 7. 测试

| 套件 | 覆盖 |
|---|---|
| `tests/test_release_builder_plan.js` | 纯规划：版本计划、状态机、roll-up、顶级状态、**结构断言**（本工具里不存在第二份发布权威） |
| `tests/test_release_builder_astages.js` | fixture / 集成 / **对照证明**：在临时目录里跑完整 CHECK→BUILD→VERIFY→SEAL，然后逐一故意破坏版本号、产物名、PE 版本、SHA、清单版本/通道、构建退出码、README 声明……确认每一种都能把 `READY` 打回 `BLOCKED` |
| `tests/test_release_builder_server.js` | 本地服务契约：只绑 127.0.0.1、逐接口要 boot token、拒绝跨源、静态路径不能逃出 `public/`、阶段门在服务端、**一键流程不含 PUBLISH**、PUBLISH 必须带确认、Dry Run 零副作用 |
| `tests/test_release_builder_exe.js` | **真启动那个双击用的 EXE**：找到的是仓库内置 `runtime\node\node.exe`（不是 PATH 上的 node）、`IB_RELEASE_NO_BROWSER=1` 下是纯服务宿主（`browserOpens===0`，且日志不得声称打开过浏览器）、GUI 页面与 `/api/snapshot` 报真实版本、无 token / 错 token 一律 403、静态路径不能穿越、杀掉 EXE 后不留 node 子进程（Windows Job Object）。EXE 没构建时跳过并返回 0 |

```powershell
node tools\release-builder\tests\test_release_builder_plan.js
node tools\release-builder\tests\test_release_builder_astages.js
node tools\release-builder\tests\test_release_builder_server.js
node tools\release-builder\tests\test_release_builder_exe.js
```

全部遵守 `docs/P7-TEST-BUDGET.md`：不联网、不安装、不开浏览器、不碰真实 `dist/`，
用完的临时目录全部删除（套件自己断言这一点）。只有 `..._exe.js` 会监听一个本地
127.0.0.1 端口（它验证的正是这个服务），它同样不开浏览器，并且刻意不把
`powershell.exe`/`cmd.exe` 计入"浏览器进程"，否则它会把自己的探针当成浏览器。

---

## 8. 目录

```
tools/release-builder/
  server.js              本地服务 + GUI 宿主（唯一 Node 入口）
  build.js               构建 IB-Release-Builder.exe 自身
  lib/
    canonical.js         ★ 唯一允许 require 仓库真源的文件
    plan.js              纯规划与状态机（零 I/O）
    log.js               结构化日志 + 真实脱敏
    git.js               只读 git + publish 侧的四个变更操作
    env.js               工具解析（绝不猜）+ 带流式输出的子进程
    check.js  build.js  verify.js  seal.js  publish.js
    runner.js            编排核心（阶段门、级联阻断、Dry Run 计划）
  public/                界面（复用产品自己的玻璃层设计 token）
  launcher/              IB-Release-Builder.exe 的 C# 源码
  tests/                 fixture + 四个套件（plan / astages / server / exe）
```

### 为什么 `canonical.js` 是唯一入口

「这个事实从哪来」必须只有一个答案。所以只有 `lib/canonical.js` 允许 require
`runtime/product-version.js`、`runtime/update-manifest.js`、`runtime/pe-version.js`、
`scripts/release-manifest.js`、`scripts/release-audit.js`，其余文件一律通过适配器调用。
`tests/test_release_builder_plan.js` 会扫描源码并在有人破坏这条规则时失败。

---

## 9. 已知边界（诚实列出）

- **GUI 需要浏览器**：这是刻意的，为了零新增依赖。界面通过一次性 boot token 绑定会话。
- **发布通道只有 Stable**：Prerelease 在界面上是禁用的，因为冻结的清单契约
  （`runtime/update-manifest.js` 的 `CHANNELS`）只认识 `stable`。给出第二个通道
  就是制造第二份发布真相。
- **不改写历史清单**：`dist\update-stable.json` 的可选字段（`releasedAt` /
  `minimumVersion`）来源会被**如实打印**，不猜测、不「修正」。
  `SEAL 重新生成清单` 需要显式勾选，且只重生成清单、绝不重编译安装器。
- **不删除 GitHub Release**：发布后对账失败时，唯一正确的动作（`docs/RELEASE.md` §6）
  是删掉 release 重来 —— 那一步由人做，工具只告诉你该做。
