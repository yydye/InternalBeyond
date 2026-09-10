# 历史归档 · History Archive

本目录保存**已完成的阶段性实施报告与审计记录**。它们记录的是"当时做了什么、怎么验证的"，
不是当前状态说明，也不代表现在的实现细节。

> 阅读顺序建议：当前状态看 [`HANDOVER.md`](../HANDOVER.md)，机制看
> [`ARCHITECTURE.md`](../ARCHITECTURE.md)，设计理由看 [`DECISIONS.md`](../DECISIONS.md)，
> 历史演进看 [`CHANGELOG.md`](../CHANGELOG.md) 与 [`CHRONICLE.md`](../CHRONICLE.md)。
> 面向普通用户的文档是根目录 [`README.md`](../../README.md) 与 [`TROUBLESHOOTING.md`](../TROUBLESHOOTING.md)。

## zero-setup/ —— Zero-Setup / Consumer Readiness 系列

让"不懂编程的普通用户"从下载到使用全程不碰命令行、不需要预装 Node.js 的整套改造。

| 报告 | 阶段 |
|---|---|
| `ZERO-SETUP-AUDIT.md` | P0 · 只读审计（起点，G1–G10 缺口清单） |
| `P1-BUNDLED-NODE-REPORT.md` | P1 · 内置 Node 运行时 |
| `P2-BOOT-STATE-REPORT.md` | P2 · 降级启动 / boot state |
| `P3-ERROR-PRODUCTIZATION-REPORT.md` | P3 · 错误产品化（IBERR 单一分类） |
| `P4-SETUP-WIZARD-REPORT.md` | P4 · 首启设置向导 |
| `P5-DIAGNOSTICS-REPORT.md` | P5 · 系统诊断与自恢复 |
| `P6-GUIDE-REPORT.md` | P6 · 零基础图文教程与截图管线 |
| `P7-INSTALLER-REPORT.md` | P7 · Windows 安装包与发行打包 |

仍在生效的测试政策 [`P7-TEST-BUDGET.md`](../P7-TEST-BUDGET.md) 保留在 `docs/` 根，
因为构建脚本与安装类测试按该路径引用它。

## runtime/ —— Runtime Stabilization / Convergence 系列

角色运行时（Runtime）契约收口与执行接缝收敛的历史记录。

| 报告 | 阶段 |
|---|---|
| `RUNTIME-INTEGRATION-AUDIT-2026-09-08.md` | 只读集成审计（起点） |
| `P2-CONTEXT-CONVERGENCE-AUDIT.md` | 上下文收敛只读核实 |
| `RUNTIME-STABILIZATION-P2-REPORT.md` | Contract Closure |
| `RUNTIME-CONVERGENCE-PHASE1-REPORT.md` | Phase 1 · active-diary 执行接缝 |
| `RUNTIME-CONVERGENCE-PHASE2-REPORT.md` | Phase 2 · moments `_obsCall` |
| `RUNTIME-CONVERGENCE-PHASE3-REPORT.md` | Phase 3 · diary 生成接缝 |
| `RUNTIME-CONVERGENCE-PHASE4-REPORT.md` | Phase 4 · Diary 域收敛 + Memory Consolidation |
| `CONTEXT-CONVERGENCE-C1-REPORT.md` | Context Convergence C1 |

## 归档约定

- 报告按**完成时的原文**保留；报告里出现的历史路径、当时测试数量、当时端口与命令不做回写。
- 报告内的引用已更新为归档后的新路径；除此之外不改写正文。
- 新增阶段报告请直接放入对应子目录，并在本文件补一行索引。
