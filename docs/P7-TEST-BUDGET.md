# P7 测试预算（Test Budget）

> 目标：**P7 期间测试绝不干扰开发环境**。测试数量不是验收目标；隔离与不破坏才是。
> 适用范围：P7 · Windows Installer / Release Packaging 全部开发与验收工作。

---

## 1. 为什么有这份预算

上一轮 P7 的 installer smoke 在开发机上反复执行
`安装 → 启动 → 升级 → 卸载`，造成了三类真实破坏：

| 破坏 | 原因 |
| --- | --- |
| 开发实例 23120 消失 | 安装包的 `PrepareToInstall → ib-stop.js` 按“端口 + 脚本名”识别并停止实例，不要求 root 匹配 |
| 反复弹出真实浏览器窗口 | `launchApp()` 未注入 `IB_LAUNCH_NO_OPEN=1`，3 处启动各弹一次 |
| 残留进程 / 临时安装树 | 多轮循环 + 缺硬超时 + teardown 不彻底 |

结论：**真实安装/启动是稀缺资源，只能按“一次”计量使用。**

---

## 2. 开发期允许的测试（默认全部静态或隔离）

| 类别 | 入口 | 是否安装 | 是否开浏览器 |
| --- | --- | --- | --- |
| Inno 配置静态检查 | `node test_installer.js` [4] | 否 | 否 |
| release manifest 检查 | `node test_installer.js` [3] | 否 | 否 |
| 内置 Node SHA / 版本检查 | `node test_installer.js` [2] | 否 | 否 |
| secret scan / 内容审计自检 | `node test_installer.js` [8] | 否 | 否 |
| staging 内容审计 | `node test_installer.js` [8]（临时目录 staging + 审计 + 删除） | 否 | 否 |
| installer 脚本单元 / Mock | `node test_installer_mock.js` | 否 | 否 |
| 启动器 / boot-state / 运行时解析 | `node test_launcher.js`、`node test_boot_state.js`、`node test_node_runtime.js` | 否 | 否（spawn 被 mock） |

`test_installer.js` + `test_installer_mock.js` 是 P7 开发期的**默认回归组合**，两者都不安装、不启动、不联网。

---

## 3. 开发期禁止

- 安装 → 启动 → 卸载循环；多轮 upgrade smoke；多轮 uninstall smoke
- 启动真实系统浏览器（唯一例外见 §4）
- 启动真实开发目录 IB 实例，或停止当前开发实例
- 完整 browser suite（`test-all.js --browser`）
- 每改一点就重跑 installer 自动测试
- 任何全局 Node 清理（`taskkill /F /IM node.exe`、`Stop-Process -Name node`）——只能按 PID 定向结束
- 反复运行 `test-all.js --quick`；P7 完成时**最多跑一次**

已知不重复验证：`middle-brain.js` BOM 并行失败（browser 组，P7 不跑该组）。

---

## 4. 唯一一次真实安装 smoke

**每个构建出来的安装包（按 exe SHA-256）只允许一次成功的真实安装 smoke。**

顺序固定，全部由 `test_installer_smoke.js --real-install-smoke` 完成：

```
构建 Installer（build-installer.ps1，默认不安装）
  → 静默安装到独立临时目录
  → 载荷审计（白名单 / secret / 运行时字节一致 / 快捷方式）
  → 启动一次（wscript → .vbs → launcher，浏览器 suppress，browserOpens === 0）
  → /health 与主页面 200
  → 运行中升级一次（同目录覆盖安装）
       · 本安装目录实例被停止、端口释放
       · runtime\node\node.exe 被干净替换（解锁等待生效）
       · 无关 Node 进程存活、用户数据保留
  → 卸载（程序文件与快捷方式移除、用户数据保留、注册表项移除）
  → 断言开发实例端口行为完全未变
```

- 闸门：harness 读 `%TEMP%\ib-p7-real-smoke-ledger.json`；同一 SHA 已成功过则**拒绝**，
  只有显式 `--allow-rerun` 才重复（会打印警告）。
- 失败不占用额度：未成功的尝试只记录 attempt，允许修复后再来一次。
- 浏览器：所有模式 `browserOpens === 0`（含真实验证），由 launcher 日志断言。
- 构建脚本默认**不做**安装审计（`-InstallAudit` 才做），避免“构建顺带装一遍”。

### 隔离硬约束（每次真实安装都必须满足）

1. 独立临时安装目录（`%TEMP%\ib-p7-smoke\install-*`，带归属标记）
2. 独立临时用户数据目录（`LOCALAPPDATA=<temp>`）——**绝不写 `%LOCALAPPDATA%\InternalBeyond`**
3. 4 个空闲端口，通过 `IB_WEB_PORT / IB_RESTART_PORT / IB_BRIDGE_PORT / IB_ACTIVE_PORT`
   传给**每一个**子进程（安装器、卸载器、启动器、停止助手）
4. 安装器自身的身份探测同样读取 `IB_*` 覆盖（`[Code] OptionPort`），因此它连读都不会读到开发实例
5. 运行前后探测开发实例四个端点的身份，`deepStrictEqual` 必须一致
6. 所有子进程 PID 记录在册，teardown 按 PID（`/F /T /PID`）结束，绝不按镜像名
7. 逐 case 硬超时（默认 60s，安装/卸载/启动 240s）+ 全局 15min；超时打印残留资源报告

---

## 5. 场景迁移表（原本靠反复实测的项）

| 原实测场景 | 现在的验证方式 |
| --- | --- |
| 停止助手只停本安装目录（A） | `test_ib_stop_identity.js`：真实隔离 fixture 进程 + 空闲端口，断言 same root 被停、different root / 无法证明归属 / 无关 Node 全部存活且未收到停止请求 |
| 损坏的内置运行时被拒绝（B） | `test_installer_mock.js` [1]：临时沙箱里用真实 `cscript` 跑 `.vbs`；截断（保留 MZ）→ 执行失败且不回退 PATH；非 MZ → 预检拒绝；真二进制 → 预检通过 |
| 安装后运行时校验（B） | `test_installer_mock.js` [7]：静态断言 `CurStepChanged(ssPostInstall) → ValidateBundledRuntime()`、`--version` 与 VERSION 比对、失败留标记且不回退 PATH |
| 运行中升级等待解锁（C） | `test_installer_mock.js` [6]：静态断言有界等待 + `--wait-unlock` + 探测从 `{tmp}` 副本启动；动态用运行中的 node.exe 副本证明「运行中不可写、退出后可写」 |
| IB_NODE → 内置 → PATH 解析顺序 | `test_installer_mock.js` [2] + `test_node_runtime.js`（静态 + 分支断言） |
| 升级时不误杀无关 node 进程 | `test_installer_mock.js` [3]（mock 进程表）+ 最终隔离验证里的诱饵进程 |
| 浏览器默认不打开 | `test_installer_mock.js` [4]：mock `spawn`，断言 seam 生效时 0 个子进程；`test_boot_state.js` 断言 `browserOpens === 0/1` |
| 安装/卸载只停一次自身实例 | `test_installer_mock.js` [5] + `test_installer.js` [4]（Inno 契约静态） |
| 干净 Windows / 用户视角矩阵 | **P8** |

---

## 6. 命令速查

```bash
# 开发期默认（不安装、不开浏览器）
node test_installer.js
node test_installer_mock.js
node test_ib_stop_identity.js

# 定向：启动器 / 运行时（仍不安装、不开浏览器）
node test_launcher.js
node test_boot_state.js
node test_node_runtime.js

# 构建（默认不安装；加 -InstallAudit 才做隔离载荷审计）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-installer.ps1

# 唯一一次隔离验证（每个构建只成功一次）
node test_installer_smoke.js --real-install-smoke

# 隔离载荷审计（构建可选步骤，不启动应用）
node test_installer_smoke.js --install-audit

# 已退役（会被拒绝并给出替代命令）
node test_installer_smoke.js --force
IB_INSTALLER_SMOKE=1 node test_installer_smoke.js
```

---

## 7. 验收口径

P7 的验收不数测试条数，只看：

- 开发实例（23120/23116/23115/23114）在全部测试前后**行为不变**
- 自动化测试 `browserOpens === 0`
- 真实安装 smoke 恰好一次，且只开一个浏览器窗口
- 静态/隔离组合全绿
- 未验证的真实场景有明确归属（P8），不是“忘了测”
