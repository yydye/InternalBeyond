# InternalBeyond — Bundled Node.js Runtime

这个目录承载 **随 InternalBeyond 一起分发的私有 Node.js 运行时**。
正式安装包必须包含它，普通用户**不需要**预先安装 Node.js、npm，也不需要配置 PATH。

## 固定版本（pinned）

| 项 | 值 |
|---|---|
| 版本 | **24.18.0**（Node.js 24 LTS 线，精确 patch，不使用浮动的 `24.x`） |
| 平台 | `win-x64` |
| 上游来源 | `https://nodejs.org/dist/v24.18.0/win-x64/node.exe` |
| SHA-256 | `9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de` |
| 上游校验清单 | `https://nodejs.org/dist/v24.18.0/SHASUMS256.txt` |
| 许可 | MIT（含 V8 / OpenSSL 等第三方条款，原文见本目录 `LICENSE`） |

> 版本与当前 IB 开发/运行环境一致（`node --version` → `v24.18.0`）。
> Node.js 版本**随 IB 版本更新**，不做运行时自动升级（不引入隐式网络请求）。

## 目录内容

| 文件 | 是否入库 | 说明 |
|---|---|---|
| `node.exe` | **否**（`.gitignore`） | 运行时本体，约 88 MiB。由 `scripts/update-node-runtime.ps1` 获取 |
| `VERSION` | 是 | 精确版本号，唯一事实源（单行，无换行符） |
| `SHA256SUMS` | 是 | `sha256sum -c` 可校验的清单 |
| `LICENSE` | 是 | Node.js 上游许可原文（必须随包分发） |
| `README.md` | 是 | 本文件 |

`node.exe` 不进入 git（避免把 88 MiB 二进制写进仓库历史）；但它**必须存在**于发行包中。

## 更新流程（开发者 / 构建期）

```powershell
# 默认读取 runtime/node/VERSION 中的版本，下载 → 校验 → 落盘 → 自检
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/update-node-runtime.ps1

# 指定版本（同时会更新 VERSION 与 SHA256SUMS）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/update-node-runtime.ps1 -Version 24.18.0

# 已存在时强制重下
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/update-node-runtime.ps1 -Force
```

脚本会：下载 `node.exe` → 与官方 `SHASUMS256.txt` 逐字节比对 SHA-256 → 写入 `node.exe` / `LICENSE` / `VERSION` / `SHA256SUMS` → 实际执行 `node.exe --version` 自检。任一步失败即中止且不留下半成品。

## 为什么只需要 `node.exe`

Windows 版 Node.js 是自包含可执行文件，除系统 DLL 外不依赖任何随附 DLL，因此**单文件即可运行**（已实测：仅复制 `node.exe` 到空目录即可执行 `--version` 与 `fetch`）。不需要 `npm`、`corepack` 或 `node_modules`。

## 运行时解析顺序（由启动入口实现）

```
IB_NODE（显式覆盖，排障/测试）
  → runtime\node\node.exe（内置，正式安装包唯一路径）
  → PATH 中的 node.exe（仅开发/兼容兜底）
  → 都不可用：明确错误提示，不静默继续
```

内置运行时存在但无法运行时（损坏/被替换）会**报错**，不会静默回退到 PATH。

## 许可与合规

- Node.js 采用 MIT 许可，允许再分发，但**必须随包提供许可原文**。
- 本目录 `LICENSE` 即上游原文；项目级说明见 `LICENSES/THIRD-PARTY-NODE.md`。
- InternalBeyond 自身为 PolyForm Noncommercial 许可：安装包只能**免费、非商业**分发。

## 安全维护

- 关注 Node.js LTS 安全发布；补丁版落地后按上述流程更新并**重建安装包**。
- 服务仍然只监听 `127.0.0.1`；内置运行时**不写入 PATH、不做全局安装、不注册系统服务**。
