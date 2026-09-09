# P7 · Windows Installer / Release Packaging 报告

> 阶段目标：普通 Windows 用户无需预先安装 Node.js / npm / PowerShell，无需管理员权限，
> 下载安装包后可直接从桌面或开始菜单启动 InternalBeyond。
>
> 结论：**达成**。最终产物 `dist\InternalBeyond-Setup-1.0.0.exe`
> （48.4 MiB，SHA-256 `5f7353b8f787f8147d1fba937e155e0ef34de7aef5e73d369c821013b6f3b7e0`），
> per-user 免 UAC，内置 Node 24.18.0；唯一一次隔离真实验证
> **安装 → 启动一次 → 运行中升级一次 → 卸载** 37/37 通过。
>
> 本阶段的两条主线：**测试预算**（把反复真实安装换成静态 + Mock + 一次隔离验收，见
> `docs/P7-TEST-BUDGET.md`）与**三个定点修复**（A 停止助手 root 绑定、B 损坏运行时提前失败、
> C 运行中升级等待解锁）。

---

## 1. 交付物

| 文件 | 作用 |
| --- | --- |
| `VERSION` / `product-version.js` | 唯一版本源（安装包、Guide、诊断页共用） |
| `installer/InternalBeyond.iss` | Inno Setup 6 脚本：per-user、免 UAC、无控制台、单一入口、安装后运行时校验、升级解锁等待 |
| `installer/runtime-pin.json` | 内置运行时钉定值（24.18.0 / win-x64 / SHA-256 / 来源） |
| `installer/tools/ib-stop.js` | 停止助手：**root 绑定** + `--wait-unlock` 文件解锁等待 |
| `installer/languages/ChineseSimplified.isl` | 中文安装界面（vendored，含来源说明） |
| `scripts/build-installer.ps1` | 一键构建：preflight → 运行时门禁 → staging → 审计 → 编译 → 校验和（默认**不安装**） |
| `scripts/release-manifest.js` / `release-audit.js` | 载荷白名单 + 内容/密钥审计 |
| `runtime/node/*` + `LICENSES/THIRD-PARTY-NODE.md` | 随包 Node 24.18.0 与第三方声明 |
| `启动 InternalBeyond.vbs` | 静默启动链：运行时解析 + 预检 + 调用 launcher |
| `dist/InternalBeyond-Setup-1.0.0.exe` / `SHA256SUMS.txt` | 发行产物与校验和 |
| `test_installer.js` | 静态契约（Inno / manifest / pin / secret / 停止助手 / 静态服务器 / 构建默认不安装） |
| `test_installer_mock.js` | Mock 行为（VBS 预检正反例、停止助手选择、浏览器 seam、升级解锁、安装后校验） |
| `test_ib_stop_identity.js` | A 专项：root identity（隔离 fixture 进程） |
| `test_installer_smoke.js` | 受预算约束的真实安装验证（默认 SKIP，每个构建只允许一次成功） |
| `test_installer_build.js` | 真实 ISCC 构建回归（显式开启） |
| `docs/P7-TEST-BUDGET.md` | 测试预算政策 |

---

## 2. 三个定点修复

### A · `ib-stop.js` 绑定安装 root

**问题**：原来按「产品端口 + 脚本名」识别实例，只要某个 checkout 占了 23120 就会被停掉。

**修复**：`--root` 变成**必需参数**，缺失时拒绝执行任何停止动作（`root-required`）。
一个进程只有满足下列**任一**证据才会被停：

| 证据 | 说明 |
| --- | --- |
| `command-line` | 命令行引用了该安装 root |
| `executable-path` | 进程映像位于该 root 内（如 `{app}\runtime\node\node.exe`） |
| `boot-state` | 该实例自己的 `/__boot-state` 报告 `launcher.root === root` |

分类结果：

- `own` → 允许优雅停止（`POST /__shutdown`、`/shutdown`），超时后按 PID 兜底 kill（再次复核归属）
- `foreign` → **不停止**：命令行指向别的 root（`other-root`），或根本不是 InternalBeyond（`not-internalbeyond`）
- `unknown` → **不停止**：是 InternalBeyond 但归属无法证明（相对路径、取不到命令行等）——宁可让用户手动关闭，也不猜

外来实例**不算我们的失败**：`remaining` 只统计 own 端口，因此别人占着 23120 不会让安装失败。
永远不按 `node.exe` 镜像名清理（`taskkill /F /IM` 在源码层被静态测试禁止）。

### B · 损坏的 bundled Node 提前失败

三层防线，全部不依赖「真实破坏一次」来验证：

| 层 | 位置 | 行为 |
| --- | --- | --- |
| 构建 | `build-installer.ps1` | 校验 `runtime/node/VERSION`、`SHA256SUMS`、实际 SHA-256、`--version`、`process.version`；任一不符直接失败，不回退系统 Node |
| 安装完成 | `InternalBeyond.iss → CurStepChanged(ssPostInstall) → ValidateBundledRuntime()` | 实际执行 `{app}\runtime\node\node.exe --version`，与 `runtime\node\VERSION` 比对；失败弹明确提示「安装包可能已损坏，请重新下载」，并在 `{app}\logs\runtime-invalid.txt` 留下标记 |
| 启动前 | `启动 InternalBeyond.vbs → RuntimeLooksValid()` | 文件大小 + `MZ` 头预检；损坏/截断的二进制在交给 Windows 之前就被拒绝，给出产品语言错误，**绝不回退 PATH** |

### C · 运行中升级：等待解锁再替换

`PrepareToInstall` 的顺序固定：

```
ib-stop.js --root "{app}"          # 只停本安装目录的实例
  → WaitForRuntimeReplaceable({app}\runtime\node\node.exe, 20000)
      · 用 ib-stop.js --wait-unlock 打开文件写句柄（运行中的映像会 EBUSY）
      · 每 300ms 重试，最多 20 秒
      · 探测进程从 {tmp} 的运行时副本启动——用被探测的文件去探测它会自我锁死
  → 仍被占用：返回用户可读原因（请关闭后重试），安装中止
    不再盲目继续到 "DeleteFile failed; code 5" 回滚
```

---

## 3. 测试预算（开发期默认行为）

| 入口 | 行为 |
| --- | --- |
| `node test_installer.js` | 纯静态，不安装、不启动 |
| `node test_installer_mock.js` | 全 Mock / 临时 fixture，不安装、不启动 |
| `node test_ib_stop_identity.js` | 隔离 fixture 进程 + 空闲端口，不碰开发实例 |
| `node test_installer_smoke.js` | 无参数 → SKIP；`--force` / `IB_INSTALLER_SMOKE=1` → 拒绝（exit 2） |
| `--install-audit` | 隔离安装 + 载荷审计 + 卸载，不启动 |
| `--real-install-smoke` | 每个构建（exe SHA-256）只允许一次成功，闸门在 `%TEMP%\ib-p7-real-smoke-ledger.json` |
| `build-installer.ps1` | 默认**不安装**（`-InstallAudit` 才做隔离载荷审计） |

隔离硬约束：临时安装目录 + 临时 `LOCALAPPDATA` + 4 个空闲端口传给每个子进程（安装器自身身份探测也读
`IB_*` 覆盖）；跑前跑后对开发实例四端点做身份比对；所有子进程按 PID 定向结束；逐 case 与全局硬超时；
`browserOpens === 0`。

---

## 4. 验收结果

### 4.1 三项专项（均为隔离 / Mock，无安装、无浏览器）

| 专项 | 结果 | 覆盖 |
| --- | --- | --- |
| A · `ib-stop` root identity | **12 / 12 通过** | 纯分类（own / foreign / unknown）+ 无 root 拒绝 + 真实隔离 fixture：same root 被优雅停止、different root 收到 0 次停止请求且存活、无法证明归属者存活、无关 Node 存活 |
| B · corrupt runtime 临时目录 | **21 / 21 通过**（与 C 同文件） | 截断（保留 MZ）→ 执行失败且不回退 PATH；非 MZ → 预检拒绝；真二进制 → 预检通过并成功执行；安装后校验静态接线 |
| C · upgrade-lock | 同上 | 静态：有界等待、`--wait-unlock`、探测从临时副本启动、失败给友好提示；动态：运行中的 node.exe 副本写句柄 EBUSY，退出后 20s 内可写 |
| 静态契约 | **38 / 38 通过** | Inno 配置、manifest、pin（含真实 SHA/版本）、secret scan、停止助手、静态服务器、构建默认不安装 |

### 4.2 唯一一次隔离真实验证

`node test_installer_smoke.js --real-install-smoke` → **37 通过 / 0 失败**：

```
安装（临时目录 + 隔离端口 + 临时用户数据）→ 载荷审计（白名单 / secret / 运行时字节一致 / 快捷方式）
→ 启动一次（浏览器 suppress，browserOpens === 0）→ /health + 主页面 200 + boot-state root 正确
→ 运行中升级（同目录覆盖安装）
     · 无关 Node 进程（另一临时目录的运行时副本）存活
     · 本安装目录实例被停止、端口释放
     · runtime\node\node.exe 被干净替换且字节一致（证明解锁等待生效）
     · 用户数据保留
→ 卸载（程序文件/快捷方式移除、用户数据保留、注册表项移除）
→ 开发实例（23120/23116/23115/23114）行为完全未变
```

账本记录该构建 `success: true`；同一 exe 再次运行会被拒绝（exit 2）。

> 过程透明：该构建之前有一次失败尝试（SHA `ab002760…`）——解锁探测从被探测的文件本身启动，
> 自我锁死导致升级被友好中止。定位后改为「从 `{tmp}` 的运行时副本启动探测」，重建后一次通过。

### 4.3 环境安全

- 开发实例全程 PID 不变（web 32860 / restart 192 / bridge 27928 / active 26536），四端点始终 200
- 自动化测试 `browserOpens === 0`
- 临时安装目录、隔离数据目录、诱饵目录、所有子进程均在 teardown 中清理；无残留进程

---

## 5. 遗留与 P8

| 项 | 说明 |
| --- | --- |
| 干净 Windows / 用户视角矩阵 | P8：全新机器、无系统 Node、多用户、UAC 交互路径 |
| 多语言 / 多架构 | 当前中文优先 + 英文，win-x64 |
| 代码签名 | 首版不做，README 已给出诚实的 SmartScreen 与 SHA-256 校验指引 |
| 升级的极端占用 | 20 秒有界等待；仍被占用时给用户明确提示（不重试、不强制覆盖） |

---

## 6. 复现命令

```bash
# 开发期（不安装、不开浏览器）
node test_installer.js
node test_installer_mock.js
node test_ib_stop_identity.js

# 构建（默认不安装）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-installer.ps1

# 唯一一次隔离验证（每个构建只成功一次）
node test_installer_smoke.js --real-install-smoke
```
