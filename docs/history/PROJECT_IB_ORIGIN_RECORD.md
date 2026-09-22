# Project-IB Origin Record

> **性质**：官方历史档案（Draft）。只记录已核验的事实、证据与边界。
> **不是**：宣传文、作者传记、现有 Chronicle 的替代。
> **依据**：Phase 0（2026-07-28 快照考古，只读）、Phase 1（上游 Git 历史恢复，L2）、Phase 2（Release Reality Audit，只读）。
> **不修改**：[CHRONICLE.md](../CHRONICLE.md)、README、WHY_IB、代码与快照。

---

## Identity

```text
中文名：        边界之外
英文名：        Project-IB
简称：          IB
主要工程实现：  InternalBeyond
项目起始：      2026-05-23
```

**说明**：Project-IB 是项目本体；InternalBeyond 是其当前主要工程实现名称。不得用 `InternalBeyond` 反推项目正式名称，也不得用工程实现名覆盖项目身份。

---

## Evidence Levels

| Level | 含义 |
|---|---|
| **L0** | Author Confirmed — 作者直接确认的信息 |
| **L1** | Primary Artifact — 原始快照、发布文件、文件内容本身 |
| **L2** | Version Control Evidence — Git commit / tag / branch |
| **L3** | Documentation Evidence — README / CHANGELOG / 说明文档 |
| **L4** | Inference — 基于证据的推断（必须显式标注） |
| **UNKNOWN** | 暂无可恢复证据，不填补 |

---

## Historical Boundary

### 2026-05-23

- **状态**：CONFIRMED
- **证据**：L0
- **描述**：Project-IB /「边界之外」开始。
- **限制**：目前没有公开 Git 或文件证据可恢复该阶段的具体实现、第一版代码或开发过程。该区间为 **UNKNOWN**。

### 2026-06-05

- **状态**：CONFIRMED
- **证据**：L2
- **描述**：**首次公开可恢复记录**（不得写作"项目创建"）。
- **commit**：`9fd2fa3` — `Add files via upload`
- **记录内容**（L1 文件清单直读）：
  - `InternalBeyond.html`（3,374 行）
  - `game/game_module.js`（4,576 行）
  - `README.md`（119 行）
  - `LICENSE`（Copyright (c) 2025-2026 Sui）
  - 全部 `game/` 素材（背景、立绘、精灵、茶/塔罗资源）
- **说明**：首个公开提交已是一个完整的单文件前端应用，而非骨架工程。

### 2026-07-28

- **状态**：CONFIRMED
- **证据**：L1 / L2
- **描述**：**第一份完整可恢复快照**。
- **载体**：桌面 `InternalBeyond-main.zip`（67 文件，SHA256 `79F63CA4…AF992D`），与仓库根提交 `c151bb1` 逐文件 blob 完全一致。
- **包含**：单文件前端应用；IndexedDB（`InternalBeyondDB` v14）；多模块系统；多项 AI 能力（详见下方 Feature Birth Map）。

---

## Early Evolution Timeline

| 日期 | 事件 | 证据 | Confidence |
|---|---|---|---|
| 2026-05-23 | Project-IB 开始 | L0 | CONFIRMED |
| 2026-06-05 | 首次公开可恢复记录（`9fd2fa3`） | L2 + L1 | CONFIRMED |
| 2026-06-06 | 新增 `index.html`（9 行跳转 → `InternalBeyond.html`）；Guide 页；Chat 分页加载 | L2（`3a46404`,`1506da9`,`557724f`） | CONFIRMED |
| 2026-06-10 | 优化密码日记本 / Tea / Story；出现「平板或手机用户下载」入口 | L2 | CONFIRMED |
| 2026-06-13~16 | 欢迎页、Story 视窗贴图 / 神秘学分组 / 书桌精灵双模式 | L2 | CONFIRMED |
| 2026-06-18 | 长期记忆库与 API 思考链；Profile 重构 | L2（`551fcbe`,`d1a730d`,`bd4a4b8`） | CONFIRMED |
| 2026-06-19 | Letter 功能重构；手机压缩版（缺失 room/music/profile） | L2（`2eb7320`,`2b6688a`） | CONFIRMED |
| 2026-06-20 | DB 版本 8→9；Chat 优化 | L2（`0b1d6d5`） | CONFIRMED |
| 2026-06-22 | 像素房间迷你视窗；桌面图标 | L2（`fa0029b`,`461ede8`） | CONFIRMED |
| 2026-06-24 | 聊天发图；API 流式传输 | L2（`461e4f6`,`61a06a4`） | CONFIRMED |
| 2026-06-27 | 缓存命中；Presence；文件上传 | L2（`abafb0b`,`6d17ff0`） | CONFIRMED |
| 2026-07-01 | 语义检索；日志批注；AI 自定义头像 | L2（`bdf3c2e`,`67f973f`） | CONFIRMED |
| 2026-07-03 | ICode 工作区；运行脚本 | L2（`03e7ce7`，仅修改 `InternalBeyond.html`） | CONFIRMED |
| 2026-07-11 | MCP **配置/连接能力**；Auto Memory；命中缓存升级；塔罗升级 | L2（`69b5237`,`2b420af`） | CONFIRMED |
| 2026-07-12 | 语音消息输入；AI 阅读 Blog；版权声明 | L2（`eae031a`,`b03b4a4`） | CONFIRMED |
| 2026-07-15 | 语音情感识别升级；现在播放歌曲感知 | L2（`fd30770`,`2c20e65`） | CONFIRMED |
| 2026-07-19 | Markdown 渲染；封档线；Blog Notes / AI 批注能力（提交信息称"伴读"） | L2（`ca3940c`,`db7dac2`,`61178b4`） | CONFIRMED |
| 2026-07-21 | Internal Bridge **客户端连接能力** | L2（`f1033a9`） | CONFIRMED |
| 2026-07-25 | 版权通知生效日期 | L3（`LICENSES/COPYRIGHT-NOTICE.md`） | CONFIRMED |
| 2026-07-26 | Calendar；版权协议更新 | L2（`29fe992` 等）+ L1（DB v14） | CONFIRMED |
| 2026-07-27 | V2.2.1 BUG 修复 | L2（`c2cf324`） | CONFIRMED |
| 2026-07-28 | README 更新 → 当日快照 → fork 基线 | L2 / L1（`c151bb1`） | CONFIRMED |

**措辞纪律**（本轮强制）：
- 2026-07-11：写「支持 MCP 配置/连接能力」，**不写**「MCP Server 上线」。
- 2026-07-19：写「Git 描述为伴读，实际验证为 Blog 阅读视图内 AI 批注能力」，**不写**「伴读模块上线」。
- 2026-07-21：写「Internal Bridge 客户端连接能力」，**不写**「后端上线」。

---

## Product Reality Model

**核心规则**：`Git commit ≠ Product Reality`。

一个功能在 Git 中出现，并不等于它进入了用户下载版本、拥有入口、或可被用户使用。判定须分状态标注：

| 状态 | 含义 |
|---|---|
| `CODE_PRESENT` | 代码存在 |
| `ENTRY_PRESENT` | 用户入口存在（按钮 / 页面 / 设置项 / 菜单） |
| `RELEASE_PRESENT` | 发布版本包含 |
| `USER_VERIFIED` | 用户实际验证可用 |
| `UNKNOWN` | 无证据 |

同一功能可能 `CODE_PRESENT` 但 `ENTRY_PRESENT` 缺失，或 `RELEASE_PRESENT` 但 `USER_VERIFIED` 失败；不得跨层替换。

---

## Historical Corrections

### 伴读

- **错误理解**：2026-07-19「伴读上线」。
- **修正**：该日 Git 提交出现"伴读"描述。
- **实际**：**Blog 阅读视图内的 AI 批注能力**（允许 AI 阅读 Blog；选中文字出现 IB 工具条「复制 + 批注笔」）。快照中"伴读"字样仅 2 处、均为说明文案，**无独立模块或顶级入口**。
- **状态**：`CODE_PRESENT` / `ENTRY_PRESENT`（仅 Blog 内）/ `RELEASE_PRESENT` / 用户侧未发现按钮。

### Internal Bridge

- **错误理解**：2026-07-21「后端服务器上线」。
- **修正**：2026-07-28 发布包**只有客户端连接能力**，**没有后端服务**。
- **依据**：快照自述「内置的是客户端协议与工具回传链路，不包含……本机执行器；……必须另行在目标电脑上运行受信任的 Internal Bridge 服务」；发布包 67 文件中**零** server / service / 可执行后端产物。
- **状态**：`CODE_PRESENT`（client）/ `ENTRY_PRESENT`（DIY「后端连接」卡片）/ `RELEASE_PRESENT`（仅客户端）。

### MCP

- **错误理解**：IB 自带 MCP Server。
- **修正**：IB 支持 **MCP 配置/连接**（DIY 页「+ 添加服务器」+ 启用开关）；**服务端由用户提供**，发布包不含 MCP 服务。
- **状态**：`CODE_PRESENT` / `ENTRY_PRESENT` / `RELEASE_PRESENT`（客户端）。

### 上游模块数量

- **记录**：`docs/CHRONICLE.md §1.2` 将上游描述为 **14 模块（含 Call / Circle / Data）**。
- **实际**：2026-07-28 快照为 **11 模块**（Room / Chat / Calendar / Blog / Letters / Memory / Music / Profile / API / ICode / DIY），**无 Call / Circle / Data**。
- **时间证据**：Circle（社交圈）首次出现于 **2026-08-16**（上游 V2.4.0）；Call（语音通话）**2026-08-26**（V2.5.0）；视频通话/礼物 **2026-08-29**（V2.6.0）——**均在 7/28 快照之后**。
- **结论**：上述 14 模块口径对应**更晚的上游**，与 7/28 快照不可混用。

---

## Feature Birth Map

| Capability | First Evidence | Evidence Level | Notes |
|---|---|---|---|
| Chat | 2026-06-05 | L1 / L3 | 首版 README 已列；含群聊 |
| Room | 2026-06-05 | L1 | `game/game_module.js` + README |
| Story | 2026-06-05 | L1 / L3 | 首版 README 已列（Room 子模块） |
| Letter | 2026-06-05（重构 2026-06-19） | L1 / L2 | 首版 README 已列；`2eb7320` 重构 |
| Memory | 2026-06-18 | L2 | `551fcbe` / `bd4a4b8` 新增长期记忆库 |
| API 思考链 | 2026-06-18 | L2 | `551fcbe` |
| Mobile（压缩版） | 2026-06-19 | L2 | `2b6688a`（缺失 room/music/profile）；前兆 2026-06-10 |
| Image Input（聊天发图） | 2026-06-24 | L2 | `461e4f6` |
| Stream（流式传输） | 2026-06-24 | L2 | `61a06a4` |
| Cache（缓存命中） | 2026-06-27 | L2 | `abafb0b` |
| Presence | 2026-06-27 | L2 | `abafb0b`；语义为离开/回来时长 + 正在播放歌曲 |
| ICode | 2026-07-03 | L2 | `03e7ce7`（单文件内新增） |
| MCP | 2026-07-11 | L2 | `69b5237`；**客户端配置/连接**，服务端用户自备 |
| Auto Memory | 2026-07-11 | L2 | `69b5237`；快照含 `autoMemory` store |
| Voice Input | 2026-07-12 | L2 | `eae031a`；语音消息输入（TTS 当时**不存在**） |
| Blog Notes | 2026-07-19 | L2 / L1 | `ca3940c` 等；快照内为 Blog 阅读视图批注，**非独立模块** |
| Bridge Client | 2026-07-21 | L2 / L1 | `f1033a9`；**仅客户端** |
| Calendar | 2026-07-26 | L2 + L1 | `29fe992`；快照 `DB_VER=14`（calEvents/calNotes/calLedger） |

---

## Unknown Periods

### 2026-05-23 → 2026-06-04

- **原因**：原作者早期环境不可访问，无公开 Git 或文件证据。
- **未知**：第一版代码；第一批功能；开发过程；期间任何事件。
- **处理**：保留为 UNKNOWN，不填补。

### 其他未决

- **Vision（模型读图）首次日期**：UNKNOWN（图片**发送**可考于 2026-06-24；模型**读取**入口未确证）。
- **Presence 最初语义**：仅可考 2026-06-27 出现；最初设计意图 UNKNOWN。
- **话题频道最早命名**：7/28 快照已存在（代码内），但 Git 命名证据晚至 2026-08-27；最早命名日期 UNKNOWN。
- **作者主观历史**：命名由来（"边界之外"）、创作动机、人物关系——UNKNOWN，只能由作者本人补充。
- **上游 IB-Mobile 仓库归属**：本仓库仅见压缩版/整合版的删除记录，独立仓库未见；UNKNOWN。

---

## Relation To Current Project-IB

当前 Project-IB 的若干系统，源自上述早期能力的**演化**。以下是演化关系，**不表示早期版本已拥有当前完整系统**：

| 早期能力 | 当前系统 | 关系性质 |
|---|---|---|
| Memory（2026-06-18 长期记忆库） | Memory + Middle Brain / Memory Consolidation | 演化：同一记忆概念的扩展与再组织 |
| Internal Bridge 客户端协议（2026-07-21） | 本机 Bridge / Home Node 服务 | 演化：早期只有"如何连接"的客户端协议；服务端为后续独立工程 |
| Blog Notes / AI 阅读批注（2026-07-19） | Co-read（共读间）/ Cinema（观影室）等场景化能力 | 演化：从"AI 阅读文字并批注"扩展到"共同进行的陪伴活动" |
| 单文件 HTML 应用 | `assets/` 模块化前端 | 演化：架构形态变化，非功能等同 |

> `L4`：以上对应关系基于两轮证据中功能语义的连续性归纳，属**推断**；不得据此宣称早期版本具备当前系统。

---

## Sources

- 上游 Git 历史：`Sui-IB/InternalBeyond`（只读 API，2026-06-05 → 2026-09-22，共 174 commits）。
- 2026-07-28 快照：`InternalBeyond-main.zip`（SHA256 `79F63CA4A46C47943708FA2942B2D57755055C26EB5C7BDE8D17BB63C2AF992D`），等同仓库根提交 `c151bb1`。
- 仓库文档：`docs/CHRONICLE.md`、`LICENSES/COPYRIGHT-NOTICE.md`（生效 2026-07-25）。
- 本轮为只读合并整理；未修改任何既有文件。

---

## Verification Notes

- `git diff --check`：新建文件，无空白错误。
- `git status --short`：仅新增本文件。
- 未启动浏览器 / 应用；未运行测试；未修改代码或既有文档；未 commit / push。
