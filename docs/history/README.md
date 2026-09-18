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

## economy/ —— Agent Economy / P22 系列

Economy v1（P22）已完成的阶段实施与审计记录。当前契约见
[`../contracts/economy/`](../contracts/economy/)（`ECONOMY_V1_FROZEN_CONTRACT.md` ·
`ECONOMY_PUBLIC_SURFACE.md` · `WIRE_NOT_FOUND_CONTRACT.md` · `DOMAIN_CONTRACT.md`），打包清单见
[`../release/ECONOMY_V1_RELEASE_MANIFEST.md`](../release/ECONOMY_V1_RELEASE_MANIFEST.md)。

| 报告 | 阶段 |
|---|---|
| `P22/P22-0-ECONOMY-AUDIT.md` | P22-0 · 只读审计（起点） |
| `P22/P22-1-ECONOMY-CONTRACT.md` | P22-1 · 领域契约（superseded，见 contracts/economy） |
| `P22/P22-19-ECONOMY-READ-CONTRACT.md` | P22-19 · owner-scoped 读模型 closure（superseded） |
| `P22/P22-2 … P22-26-*.md` | P22-2 ~ P22-26 · 实施 / 审计 / closure 阶段记录 |

## Middle Brain / Runtime

Middle Brain runtime architecture 的**当前权威**见
[`../architecture/MIDDLE_BRAIN.md`](../architecture/MIDDLE_BRAIN.md)；以下为历史演进记录。

| 报告 | 阶段 |
|---|---|
| `runtime/P11-3-MIDDLE-BRAIN-SEMANTICS-CLOSURE.md` | P11-3 · runtime semantics closure |
| `runtime/CONTEXT-CONVERGENCE-C1-REPORT.md` | Context Convergence C1 |
| `runtime/P2-CONTEXT-CONVERGENCE-AUDIT.md` | 上下文收敛只读核实 |
| `platform/ASTRA_READINESS_PHASE1.md` | Astra Readiness Phase 1 |

## memory/ —— Memory

Memory 的**当前 authority** 见
[`../architecture/MEMORY.md`](../architecture/MEMORY.md) 与
[`../contracts/memory/`](../contracts/memory/)（canonical = Home Node `memory_records`）。
历史记录分散在 runtime/（context convergence / 集成审计）。

| 报告 | 阶段 |
|---|---|
| `runtime/CONTEXT-CONVERGENCE-C1-REPORT.md` | 上下文收敛 C1（含 memory 契约闭合） |
| `runtime/P2-CONTEXT-CONVERGENCE-AUDIT.md` | 上下文收敛只读核实 |

## voice/ —— Voice

Voice 的**当前架构与契约**见
[`../architecture/VOICE.md`](../architecture/VOICE.md) 与
[`../contracts/voice/`](../contracts/voice/)。
`P23-*` 为开发中的 provisional phase 文档（尚未归档）；voice 早期记录在 legacy/。

| 报告 | 阶段 |
|---|---|
| `legacy/voice-runtime-phase1.md` | Voice Runtime Phase 1（被 bridge/voice-runtime.js 取代） |
| `legacy/voice-runtime-phase2-3.md` | Voice Runtime Phase 2–3（被 P23-2A/2B/2C 拆分取代） |

## companion/ —— Companion / Autonomy / Social

Companion 的**当前架构与 authority 边界**见
[`../architecture/COMPANION.md`](../architecture/COMPANION.md) 与
[`../contracts/companion/`](../contracts/companion/)；
自主行为机制见 [`../AUTONOMY.md`](../AUTONOMY.md)，社会闭环见 [`../SOCIAL_RUNTIME.md`](../SOCIAL_RUNTIME.md)。

| 报告 | 阶段 |
|---|---|
| `platform/ROLE_DM_RELATIONSHIP_PHASE4_AUDIT.md` | Role DM / relationship 后果只读审计 |

## moments/ —— Moments

Moments 的**当前架构与 authority** 见
[`../architecture/MOMENTS.md`](../architecture/MOMENTS.md) 与
[`../contracts/moments/`](../contracts/moments/)；
social mechanism 见 [`../SOCIAL_RUNTIME.md`](../SOCIAL_RUNTIME.md)。

| 报告 | 阶段 |
|---|---|
| `runtime/RUNTIME-INTEGRATION-AUDIT-2026-09-08.md` | 集成审计（含 moments 收敛） |
| `runtime/RUNTIME-STABILIZATION-P2-REPORT.md` | runtime 稳定化 |

## disclosure/ —— Disclosure

Disclosure 的**当前架构与 authority** 见
[`../architecture/DISCLOSURE.md`](../architecture/DISCLOSURE.md) 与
[`../contracts/disclosure/`](../contracts/disclosure/)；
decision provenance 见 [`../DECISIONS.md`](../DECISIONS.md) D30 / D31。
（当前 production 集成为 PROVISIONAL：`authorize()` 尚无 consumer。）

## 归档约定

- 报告按**完成时的原文**保留；报告里出现的历史路径、当时测试数量、当时端口与命令不做回写。
- 报告内的引用已更新为归档后的新路径；除此之外不改写正文。
- 新增阶段报告请直接放入对应子目录，并在本文件补一行索引。
