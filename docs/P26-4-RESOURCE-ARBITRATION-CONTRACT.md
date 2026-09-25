# P26-4 · Resource Arbitration Contract

状态：**FOUNDATION / CONTRACT / PURE CORE / AUDIT-FIRST / NO PRODUCTION INTEGRATION**。
建立 `assets/js/resource-core.js`。
**Production resources = 0**：Cinema / Voice / Camera / Microphone / GPU / Model Router / Mobile
全部零接线、零改动；**没有** Resource Manager / Lease Store / Priority Engine / Scheduler /
Lock Service / Queue System / Device Controller。

---

## 1. Definition

> **Resource = a constrained entity whose simultaneous usage requires explicit ownership
> or arbitration.**

不是 Capability · 不是 Session · 不是 Observation · 不是 Event · 不是 Permission。
Resource 只描述"**被争用的对象**"以及"**两个 requester 同时要它时的契约结果**"。

## 2. Classification（§4，文档分类，Core 不持有产品词汇）

| 分类 | 判据（用容量表达） | 仓库中的真实候选 | 进入 Arbitration Contract？ |
| --- | --- | --- | --- |
| **A. Exclusive Resource** | `capacity === 1`（同一时刻只有一个持有者） | 麦克风（`getUserMedia`）、摄像头 / 帧捕获（`grabFrame`）、单一播放器实例 | **YES**（最典型的仲裁对象） |
| **B. Shared Resource** | `capacity > 1`（可并发，但有上限） | 网络连接 / 模型并发请求 | **YES**（容量耗尽即 conflict） |
| **C. Quota Resource** | `capacity = 预算`，claim 带 `amount` 累计 | 模型 token 预算（`maxTokens` / 共享预算表） | **YES**（超额即 conflict） |
| **D. Virtual Resource** | 每个 `resourceId` 一个 surface（`capacity === 1`） | UI 表面 / 小窗位置 / 拖拽面板 | **YES**（同 id 争用；不同 id 不冲突） |

不在契约里的（**分类为 Runtime state / Transport / Capability，不是 Resource**）：
播放进度与字幕（`activities.progress` = 域 state）、Active Message 计划队列（域状态机）、
P23 交付队列（交付运行时）、Mobile 前后台切换（传输 / 平台事件）。

## 3. Identity

`resourceId` 必须 **stable / injectable / deterministic**：

- **调用方注入优先**（`resourceId:'mic.default'`）；
- 未注入时由 core 确定性派生：`'res_' + stableToken(domain|capacity)`；
- **禁止**全局注册表、随机 id、隐藏时钟（守卫 R4 / R15c）。

`resourceClass` 是**可选标签**（`exclusive|shared|quota|virtual`），只用于可读性，
**不参与仲裁** —— 仲裁只看 `capacity` 与 `amount`，避免"两套权威"。

## 4. Claim（§7）

```
{ claimId,        // REQUIRED  稳定身份（注入或确定性派生）
  resourceId,     // REQUIRED  要申请的资源
  requesterId,    // REQUIRED  **canonical id** —— session / capability / runtime 都可以是 requester
  amount?,        // OPTIONAL  默认 1；独占 = amount === capacity
  sessionId? }    // OPTIONAL  若这次申请属于某个会话（Session 关联是可选的，不是所有权）
```

**requester 是谁？** —— 契约**不区分层**：Session、Capability、Runtime 都可以发起 claim，
它们都必须是 canonical id（昵称含空格/非 ASCII 一律拒绝）。
**Core 不持有 claim 列表**：当前持有者（holders）由 **caller 提供**（这是"没有 Lease Store"的原因）。

## 5. Ownership

Resource Core **owns**：resource identity · ownership concept · conflict semantics ·
arbitration result shape。
Resource Core **不 owns**：actual hardware control · opening device · releasing device ·
scheduling work · persistence · transport。
换言之：Core 回答"**谁现在算持有**、**这次申请的结果是什么**"，从不**打开**或**释放**任何设备。

## 6. Conflict（§16：两个 requester 同时要麦克风）

只定义**契约结果**，不实现抢占 / 排队 / 等待：

| 情况 | 结果 |
| --- | --- |
| 独占资源（`capacity=1`）、无人持有 | `grant`（`remaining` 变为 0） |
| 独占资源、已被**别人**持有 | **`conflict` / `capacity-full`**（不抢占、不排队；caller 自己决定何时重试） |
| 已被**同一 requester**持有（不同 claim id） | **`conflict` / `requester-already-holds`**（不自动合并、不自动续借） |
| 共享资源、剩余容量足够 | `grant` |
| 配额资源、累计 `amount` 超出 | **`conflict` / `capacity-full`** |
| claim 的 `amount > capacity` | `deny` / `amount-exceeds-capacity` |
| claim 的 `resourceId` 与 resource 不一致 | `deny` / `resource-mismatch` |
| resource / claim 非法 | `deny` / `invalid-resource` · `invalid-claim` |

**注意**：`conflict` 是"现在不行"，**不是**"永远不行"，也**不**代表系统会替 caller 排队。

## 7. Decision（§8，结果闭集）

`grant` · `conflict` · `deny` —— 三者**互斥且穷尽**（守卫 R5/R11 钉住闭集，且 `preempt` 不在其中）。
**没有** `priority` 参数、**没有** auto-preempt、**没有** queue item、**没有** wait 状态。

## 8. Session relation

**Session 可以请求 Resource，但 Session 不拥有 Resource**：`sessionId` 只是 claim 上的可选关联字段；
Resource 的可用性**不随 Session 生命周期变化**（Session 结束不会自动释放设备 —— 释放是 caller 的责任，
而 Core 既不持有 holders 也不实现 release API）。

## 9. Capability relation

Capability **可以提出 resource request**（例如未来"开始语音通话"能力在 Authority 之后申请麦克风），
但 **Resource 不执行 capability**：Core 内零 Authority / Executor / canonical writer 引用（守卫 R13）。
顺序永远是：`Capability → Authority → Executor`，而 Resource 只是 Executor 可能需要的**前置条件**。

## 10. Observation relation

**Observation 可以描述 resource state**（例如 `domain:'voice'` + `source:'device.mic'` +
`valueRef:'resource.mic.default#available'`），但：

- Observation **不申请**资源（不产生 claim）；
- Resource Core **不依赖** Observation（守卫 R14），也不读取任何状态；
- "麦克风现在可用"是观察；"我要占用麦克风"是 claim。两者不能混。

## 11. Event relation

仲裁结果**未来可以产生事件**（例如 `resource.granted` / `resource.conflict`），
但本阶段**不接 Event Bus**（守卫 R15：零 `emit` / 订阅 / 事件 core 引用）。
未来接线时事件仍是 P26-1 的 post-effect fact，且不得成为第二 canonical writer。

## 12. Persistence

**禁止** resource store / lease database / lock table（守卫 R8）：Core 不持久化任何 claim，
也没有 TTL / 过期（**没有 lease**）；`DB_VER` 与 store 列表未变（G9）。

## 13. Transport

**禁止** device manager / IPC resource controller / hardware bridge（守卫 R6/R7）：
Core 不触碰 `navigator.mediaDevices` / `getUserMedia` / `MediaRecorder` / `RTCPeerConnection` /
`AudioContext` / 全屏 API / fetch / WebSocket / IPC。

## 14. Non-goals

本阶段**不**实现：Resource Manager · Lease Store · Lock Service · Priority Engine · Scheduler ·
Queue System · Device Controller · Hardware Bridge · 仲裁的**执行**（acquire/release）·
跨进程资源控制 · 资源事件；**不**接入 Cinema / Voice / Camera / Microphone / GPU /
Model Router / Mobile；**不**修改任何域生产代码或 P23/P24/P25 foundation。

---

## 附：Existing Resource Audit（Phase 0，只读）

| 候选 | 事实（代码） | 分类 | 是否真 Resource？ |
| --- | --- | --- | --- |
| A. Cinema playback surface | `apps/ib-app-cinema.js` 一个播放器实例 + `IBMedia` adapter（load/play/pause/seek/destroy） | Runtime state + **Virtual Resource**（播放面） | 播放面 = YES（virtual）；播放进度 = **NO**（域 state） |
| B. Audio output | `communication/voice.js` / `bridge/tts.js` 的播放通道 | Runtime / Transport | NO（运行时通道，无争用契约） |
| C. Microphone | 语音通话（`communication/voice.js` + `bridge/voicebox.js`）使用麦克风 | **A. Exclusive Resource** | YES（最典型） |
| D. Camera / frame capture | Cinema `grabFrame()`（canvas 截图，不调用 getUserMedia） | **Observation**（P26-2）+ 潜在 A | 今天不是设备争用（无摄像头句柄）；未来录屏/摄像头 = YES |
| E. Voice channel | 语音呼入（Active Message 的 `voice_call` 计划）+ 通话会话 | **Session**（P26-3）+ Transport | 通道本身 = Transport；通话 = Session |
| F. GPU / model execution | `agent-runtime.js` / `ib-model-core.js` 的并发模型调用；预算表 `_IB_BUDGET_CAP_TOKENS` | **C. Quota Resource**（token 预算）+ B（并发） | 预算 = YES（quota）；单次调用 = Capability |
| G. Network connection | `fetch` 到 provider / companion | **B. Shared Resource**（连接数） | 连接池 = YES（shared）；单次请求 = Capability |
| H. File / storage access | IndexedDB / localStorage / Home Node 文件 | Runtime state / Persistence | NO（存储不是"争用对象"） |
| I. Mobile foreground/background | Mobile Gateway 的设备订阅与 `presence.changed` | Transport / 平台事件 | NO（不是可被 claim 的资源） |

**不强行统一**：只有 A（播放面）/C（麦克风）/F（预算）/G（连接）以及未来的摄像头/录屏属于 Resource；
其余是 runtime state、transport、session 或 capability。
