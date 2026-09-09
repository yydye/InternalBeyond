# P1 · Bundled Node Runtime —— 实施与验收报告

> 阶段：Zero-Setup / Consumer Readiness · **P1**
> 状态：**已完成**（P2 未开始，按要求停在 P1）
> 依据：`docs/history/zero-setup/ZERO-SETUP-AUDIT.md` §5 / §10，以及用户对开放问题的确认（Node 24 LTS、per-user 免 UAC、系统默认浏览器、Vision 默认不装）
> 审计基线：master（工作树含并行会话未提交改动）

---

## 1. 修改文件

| 文件 | 类型 | 说明 |
|---|---|---|
| `runtime/node/VERSION` | 新增 | 精确版本号（唯一事实源，单行无换行） |
| `runtime/node/SHA256SUMS` | 新增 | `sha256sum -c` 可校验清单 |
| `runtime/node/LICENSE` | 新增 | Node.js 上游许可原文（2946 行，157,606 B） |
| `runtime/node/README.md` | 新增 | 来源、校验、更新流程、解析顺序、合规说明 |
| `runtime/node/node.exe` | 新增（**gitignore**） | 88.2 MiB 运行时本体，由构建脚本获取 |
| `scripts/update-node-runtime.ps1` | 新增 | 下载 → 官方 SHA-256 校验 → 落盘 → 自检 |
| `LICENSES/THIRD-PARTY-NODE.md` | 新增 | 第三方再分发署名与许可记录 |
| `test_node_runtime.js` | 新增 | 17 项 P1 回归（含无回归护栏） |
| `启动 InternalBeyond.vbs` | 修改 | Node 解析顺序 + 版本校验 + 产品化错误；保持 GBK/LF/无 BOM |
| `Start Internal Beyond.cmd` | 修改 | 兼容别名入口同样优先内置 runtime |
| `.gitignore` | 修改 | 排除 `runtime/node/node.exe`（仅追加 ASCII，未触碰既有损坏行） |
| `test-all.js` | 修改 | 登记 `test_node_runtime.js`（static 31→32，总条目 92→93） |
| `README.md` | 修改 | 同步"内置 Node 运行时"事实与解析顺序 |

**未改动**（遵守约束）：`local-services-runner.js`、`launch-internal-beyond.js`、`ib-bridge-service.js`、`active-message-service.js`、`internal-beyond-server.js`、任何前端脚本、任何 provider metadata。

---

## 2. bundled Node 的精确版本

| 项 | 值 |
|---|---|
| 版本 | **24.18.0**（Node.js 24 LTS 线，精确 patch，非 `24.x`） |
| 平台 | `win-x64` |
| 与开发环境 | 一致（本机 `node --version` → `v24.18.0`） |
| 校验 | 官方 `SHASUMS256.txt` 比对通过 |

---

## 3. runtime 目录与来源

```
runtime/node/
  node.exe     92,534,088 bytes (88.24 MiB)   ← gitignored，构建期获取
  VERSION      24.18.0
  SHA256SUMS   9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de *node.exe
  LICENSE      Node.js 上游许可原文（2946 行）
  README.md    来源/校验/更新/合规
```

| 项 | 值 |
|---|---|
| 上游 URL | `https://nodejs.org/dist/v24.18.0/win-x64/node.exe` |
| 校验清单 | `https://nodejs.org/dist/v24.18.0/SHASUMS256.txt` |
| 许可原文来源 | `https://raw.githubusercontent.com/nodejs/node/v24.18.0/LICENSE` |
| SHA-256 | `9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de` |
| 获取方式 | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/update-node-runtime.ps1`（`-Version` / `-Force` 可选） |

只保留 `node.exe` 的依据：Windows 版 Node 是自包含可执行文件，除系统 DLL 外不依赖随附 DLL——已实测仅复制 `node.exe` 到空目录即可执行 `--version` 与使用 `fetch`。

---

## 4. Node 解析逻辑

统一顺序（`runtime/node/README.md` 与两个入口一致）：

```
IB_NODE（显式覆盖，排障/测试）
  → <安装目录>\runtime\node\node.exe（内置，正式安装包唯一路径）
  → PATH 中的 node.exe（仅开发/兼容兜底）
  → 都不可用：明确错误并退出（不静默继续）
```

实现要点：

- `.vbs` 用 `fso.FileExists` 判定内置/`IB_NODE` 是否存在，用 `where node.exe`（隐藏窗口）判定 PATH 兜底。
- 解析后**实际运行**该 node 取版本（`NodeVersion()`），而不是只信文件存在。
- 版本低于 18 直接拒绝启动。
- 内置 runtime 与 `VERSION` 记录不一致时**只告警不阻断**（便于本地替换排查）。
- `WScript.Shell.Run` 不做 shell 重定向（实测直接拼 `cmd /c ... > file` 返回 `rc=9`），因此版本探测改为生成临时 `.cmd` 后以隐藏窗口执行——**不弹黑框**。

---

## 5. 开发环境 fallback 行为

- 开发者不改变任何习惯：`start-local-services.cmd` / `start-bridge-service.cmd` / `start-active-service.cmd` / `node local-services-runner.js --status|--json` / `test-all.js` 全部原样可用。
- 全新克隆（无 `runtime/node/node.exe`）时，`.vbs` 与 `.cmd` 自动回退到 PATH 的 node——**开发无需先跑下载脚本**。
- `IB_NODE` 可显式指定任意 node（测试/排障），优先级最高。
- PATH fallback 仅为兜底：**正式安装包必须携带内置 runtime**（P7 安装器将校验其存在）。

---

## 6. bundled runtime 缺失 / 损坏行为

| 情形 | 行为 | 退出码 |
|---|---|---|
| 内置缺失 + PATH 有 node | 使用 PATH node（开发兜底），日志记录 `src=PATH` | 0 |
| 内置缺失 + PATH 无 node | 明确错误："内置运行环境缺失，系统 PATH 中也没有 Node.js，请重新安装 InternalBeyond" | 1 |
| 内置存在但无法运行（损坏） | 明确错误："内置 Node.js 运行环境损坏，请重新安装 InternalBeyond"，**绝不回退 PATH** | 1 |
| `IB_NODE` 指向不存在 | 明确错误并指出该路径 | 1 |
| `IB_NODE` 指向无法运行 | 明确错误并指出该路径 | 1 |
| Node 主版本 < 18 | 明确错误："版本过低（当前 vX，需要 18 或更高）" | 1 |

- 双击（wscript）时错误走 Windows 原生弹窗；自动化（cscript）时写 stdout 并返回退出码——同一套逻辑，无隐藏分支开关。
- 所有判定均写 `logs\launcher.log`（不记录任何密钥）。

---

## 7. Windows 无系统 Node 场景验证结果

在隔离 harness 中运行真实 `启动 InternalBeyond.vbs`（`cscript` 模式），六种场景全部符合预期：

| 场景 | 构造 | 实际结果 | 结论 |
|---|---|---|---|
| S1 内置优先 | 有 `runtime\node\node.exe`，PATH 也有 node | 使用 `…\runtime\node\node.exe` v24.18.0 | ✅ |
| S2 PATH 兜底 | 无内置，PATH 有 node | 使用 PATH node v24.9.0 | ✅ |
| S3 IB_NODE 覆盖 | 无内置，`IB_NODE` 指向内置 node | 使用 `IB_NODE` 指定路径 v24.18.0 | ✅ |
| S4 完全无 Node | 无内置 + `PATH` 移除 node | 报错退出 1，未启动任何服务 | ✅ |
| S5 内置损坏 | 内置 `node.exe` 为垃圾字节 + PATH 有 node | 报错退出 1，**未回退 PATH** | ✅ |
| S6 版本过低 | `IB_NODE` 指向输出 `v16.20.2` 的假 node | 报错退出 1："版本过低" | ✅ |

`.cmd` 别名入口同样验证：内置优先 / PATH 兜底 / `IB_NODE` 覆盖三例均正确。

---

## 8. Bridge / Active 是否继承 bundled `process.execPath`

**确认继承，且为实证结论。**

- 代码层：`local-services-runner.js` 的 `SERVICES[].command` 保持 `process.execPath`（P1 未重构，已加无回归断言）。
- 实证：用 `runtime\node\node.exe` 启动 `local-services-runner.js`（隔离端口 24115/24114/24116 + 临时数据目录），健康检查通过后查询子进程：

```
ProcessId 4380   ExecutablePath <repo-root>\runtime\node\node.exe
                 CommandLine    ...\runtime\node\node.exe ...\ib-bridge-service.js
ProcessId 33056  ExecutablePath <repo-root>\runtime\node\node.exe
                 CommandLine    ...\runtime\node\node.exe ...\active-message-service.js
```

Bridge `/health` 返回 `{ok:true,server:"IB Bridge"}`、Active `/health` 返回 `{ok:true,service:"internal-beyond-active-messages",version:3}`。验证后已清理进程与临时目录。

---

## 9. 体积变化

| 项 | 数值 |
|---|---|
| `node.exe` | 92,534,088 B = **88.24 MiB** |
| 入库元数据合计（LICENSE/VERSION/SHA256SUMS/README/第三方声明/脚本/测试） | **181,669 B ≈ 177 KiB** |
| git 仓库增量 | **约 177 KiB**（`node.exe` 已 gitignore，不进仓库历史） |
| 工作树增量（本机） | 约 88.4 MiB |
| 预估安装包增量 | **约 25–30 MiB**（Inno Setup LZMA2 压缩后，P7 实测确认） |

---

## 10. 许可证文件

- `runtime/node/LICENSE`：Node.js 上游许可原文，随安装包分发（含 V8/OpenSSL/libuv 等第三方条款）。
- `LICENSES/THIRD-PARTY-NODE.md`：记录组件、版本、平台、来源、SHA-256、许可、用途边界、与 IB 自身许可的关系。
- Node.js 为 MIT，允许再分发；IB 自身为 PolyForm Noncommercial → **安装包只能免费、非商业分发**（已在第三方声明中写明）。
- `node.exe` 与上游官方发布逐字节一致（SHA-256 可复核）。

---

## 11. Node 24 下完整回归测试结果

运行环境：`node v24.18.0`（即 bundled 版本）。

| 组 | 结果 |
|---|---|
| **static** | 32 项 · 1 失败 |
| **service** | 16 项 · 全部通过 |
| **browser** | 45 项 · 1 失败 |
| **新增 `test_node_runtime.js`** | 17 通过 / 0 失败（全新克隆模拟下 14 通过 / 2 跳过） |

**两处失败均与 P1 无关，且均为并行会话在途改动 / flake：**

1. `static → test_frontend_structure.js → encoding.bom.assets\js\middle-brain.js`
   `assets/js/middle-brain.js` 丢失 UTF-8 BOM（TROUBLESHOOTING T10 记录的高频复发问题）。
   证据：`git show HEAD:assets/js/middle-brain.js` 首字节为 `EF BB BF`，工作树首字节为 `/*`；该文件有 **29 插入 / 5 删除** 的未提交改动，属并行会话（`session-61898512`）在途编辑。**P1 未触碰该文件。**
2. `browser → test_basement_cdp.js → persist.stairRestored`
   单独重跑该测试**通过**（`The Basement / INFERNAL BEYOND CDP passed ✔`），判定为 45 项串行 CDP 运行中的 flake。该测试只加载 `InternalBeyond.html`（并行会话在途修改），**P1 未触碰任何前端文件**。

P1 自身 17 项断言全绿，其中包含四条无回归护栏：
- runner 仍以 `process.execPath` 启动服务、仍 `windowsHide`、stdio 契约未变；
- launcher 仍以 `process.execPath` 隐藏启动子进程；
- `.gitignore` 只排除二进制、不排除元数据；
- `.vbs` 仍是 GBK/ANSI + LF + 无 BOM（VBScript 会误读 UTF-8 中文）。

---

## 12. 风险与遗留

| 项 | 说明 | 处置 |
|---|---|---|
| `node.exe` 不在 git | 全新克隆需跑一次 `scripts/update-node-runtime.ps1` | 已在 README / runtime README 写明；P7 安装器构建将强制校验其存在 |
| 未签名 | SmartScreen 可能拦一次 | 用户已决策首版不购证书；P6 教程覆盖该步骤，P7 保留签名能力 |
| Node 安全补丁 | 绑定版本不自动升级 | 固定重建流程；诊断页将显示实际版本（P5） |
| 安装包体积 +25–30 MiB | 换取零门槛 | 可接受；未引入 Electron（+150 MiB 起） |
| `.gitignore` 既有字节损坏 | 第 10 行丢失一个字节、第 12 行是 GBK 而其余为 UTF-8 | **本次仅追加 ASCII**，未修复既有损坏（不在 P1 范围，建议单独修） |
| 日志路径文案 | `Start Internal Beyond.cmd` 提示 `%LOCALAPPDATA%\...\launcher.log`，实际写 `<install>\logs\launcher.log` | 归入 **P2**（日志路径统一） |

---

## 13. 下一步（未执行）

按用户指令，**P1 完成后停下，不进入 P2**。
P2 将处理：Bridge/Active 失败不阻断主 UI（G10）、fatal/degraded 区分、`boot-state.json` 供前端诊断感知、启动器产品化文案、单实例保护、日志路径统一。
