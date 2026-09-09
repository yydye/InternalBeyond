# 第三方组件：Node.js Runtime（随包分发）

本文件记录 InternalBeyond 发行包中随附的第三方运行时，用于满足其许可的
再分发署名与许可原文要求。它**不改变** InternalBeyond 自身的许可
（PolyForm Noncommercial 1.0.0 / 素材 CC BY-NC-SA 4.0）。

## 组件

| 项 | 值 |
|---|---|
| 名称 | Node.js |
| 版本 | **24.18.0**（LTS，精确 patch） |
| 平台 | Windows x64 |
| 分发形态 | 单文件 `node.exe`，位于 `runtime/node/node.exe` |
| 上游来源 | <https://nodejs.org/dist/v24.18.0/win-x64/node.exe> |
| 校验清单 | <https://nodejs.org/dist/v24.18.0/SHASUMS256.txt> |
| SHA-256 | `9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de` |
| 许可 | MIT（Node.js 本体），并包含 V8、OpenSSL、libuv 等第三方组件的各自许可 |
| 许可原文 | `runtime/node/LICENSE`（随安装包分发，共 2900+ 行，涵盖全部第三方条款） |
| 版权 | Copyright Node.js contributors. All rights reserved. |

## 用途与边界

- 用途：为 InternalBeyond 的本地服务（Bridge `127.0.0.1:23115`、Active
  companion `127.0.0.1:23114`、静态 Web `127.0.0.1:23120`）提供运行时，
  使普通用户无需自行安装 Node.js。
- 未修改：随包二进制与上游官方发布逐字节一致（可用上表 SHA-256 复核）。
- 不写 PATH、不做全局安装、不注册系统服务、不自动升级。
- 服务仅监听回环地址，不对外暴露。

## 为什么可以再分发

Node.js 采用 MIT 许可，允许在保留版权声明与许可原文的前提下再分发。
InternalBeyond 通过 `runtime/node/LICENSE` 随包提供该原文，并在本文件记录
来源、版本与校验值。

## 与 InternalBeyond 许可的关系

- InternalBeyond 代码：PolyForm Noncommercial License 1.0.0（见 `LICENSES/LICENSE-CODE.md`）。
- InternalBeyond 素材与文档：CC BY-NC-SA 4.0（见 `LICENSES/LICENSE-ASSETS.md`）。
- 上述许可**不覆盖** Node.js；Node.js 仍适用其自身 MIT 许可。
- 由于 InternalBeyond 为非商业许可，包含本运行时的安装包**只能免费、非商业分发**，
  不得出售或打包进付费产品。
