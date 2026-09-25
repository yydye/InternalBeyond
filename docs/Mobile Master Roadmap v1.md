# InternalBeyond Android / Mobile 总路线图

**路线图基线：2026-09-14**
**最近修订：P11-3G · Change-Log Delivery Closure 完成并提交（`327dbfb`）—— change_log 第一次有了**投递语义**。修复前实测（真实 spawn 私有 Home Node + 真实 HTTP + 真实 moments-authority）：`applyChanges` 把整页 event 串成一条 promise、**第一个失败即整页拒绝**，而 cursor 只在整页成功时前进 —— 窗口第一条永久失败时每轮 sync **只尝试那一条**（put=1 / putFail=1），cursor 恒定不动，服务端每轮发回同一个 `limit=100` 窗口且 `hasMore=true`，**窗口后段永久不可达**；全程没有任何 attempts 计数（谈不上上界，也谈不上"重启归零"）；驱动**解析成 `false`（没有写）**被当成已应用 → cursor 越过一条从未落盘的 event（静默丢失）；change_log **从不回收**。本阶段关闭：ACK 的精确语义（**ACK(W) = consumer 对 revision ≤ W 的每个 event 都已得出持久结论**，不证明 HTTP 200/读过/尝试过）、四状态不压成一个 boolean、有界 attempts + 非零退避 + 持久化（住浏览器 meta 平面，**不新建表、不升 schema**）、终态 → cursor 越过 → 本页继续 → **快照**补回（3F hydrate 契约一字未改）、回收只删「全体已注册水位的最小值」以下且没有水位时**一行都不删**、`/moments/changes` 如实报 `retainedFrom`（缺它即拒收）。127 项专项 + 14/14 mutation CAUGHT。⚠️ 3F 登记的三项债务（migration-before-hydrate · memory/understanding/chat 的独立 hydrate · moments.js 直写与裸只读事务）**一条未动**，并新增登记 `active/http.js GET /events` 的同形状窗口（companion 事件面，不在 change-log 投递范围内）。**
核心原则：**Home Node / Desktop 保持唯一 Runtime 与世界状态；Android 是原生 Companion Client，不复制第二套 Runtime，不持有 Provider Key。**

**状态图例**：✅ 已完成（附 commit） · ⏳ 未完成 · ● 阶段标题（非状态）

------

# 0. 总体目标

最终形态：

```text
                         InternalBeyond
                              │
                    ┌─────────┴─────────┐
                    │                   │
              Canonical Runtime      Home Node
                    │                   │
       Middle Brain / Memory / Skills   │
                    │                   │
          ┌─────────┼─────────┬─────────┐
          │         │         │         │
       Desktop    Android   Tauri 2   Channels
          │         │         │         │
          │     Companion     │      QQ / etc.
          │         │         │
          └─────────┴─────────┘
                    │
              同一个 IB 世界
```

## 不变的硬边界

- Android **不持有 Provider API Key**
- Android **不运行第二套 AI Runtime**
- Android **不复制 Canonical Memory DB**
- Android 不自己实现 Middle Brain
- Home Node 是 Mobile 世界状态 Authority
- Provider / Character / Memory / Middle Brain 的 canonical contract 不在手机重新实现
- Android 可以拥有：
  - UI
  - Local Cache / Mirror
  - Native Capability
  - Offline State
  - Device Identity
- Skills 在 Home Node / PC 执行，Android 负责请求、状态和结果展示

------

# I. Foundation / Middle Brain 收口

## P11-2A ～ P11-2D ✅

已经完成的 Middle Brain / Integrity 基础阶段。

核心成果：

- Character Integrity / OOC Guard
- Persona
- Speech Style
- Relationship
- Emotional Continuity
- Knowledge Boundary
- Side Effect Gate
- Trace / Observability

------

## P11-2E ✅

**Mobile / Group 相关生产接线阶段**

后续审计已经确认：

> 当前实际上不存在 Android Group Runtime。

因此不能把 Android 当作已经拥有：

```text
ChatOrchestrator
MiddleBrainPolicy
GroupRuntime
```

的独立运行端。

------

## P11-2F ✅ `582fb01`

### Desktop Group Memory Policy + Group Trace Hardening

完成：

- Group Memory Policy
- private role memory boundary
- group-as-character 防护
- group trace
- participant trace
- memory scope
- policyDecision
- blockedReason
- 多角色身份边界测试
- falsification / mutation

同时发现：

- Android Group Runtime 实际不存在
- 群名未经处理进入 system prompt

------

## P11-2G ✅ `8058184`

### Memory Visibility Core

完成：

```text
memory-visibility-core.js
```

建立 canonical：

```text
normalizeViewer
canReadMemory
changeVisibilityOf
partitionByAccess
```

并完成：

- visibility ACL
- principal normalization
- fail closed
- `public`
- `private`
- `only`
- `except`
- malformed visibility
- missing visibility
- unknown visibility

### Memory Sync Revocation

建立：

```text
可见
 ↓
客户端缓存

权限收窄
 ↓
visibility-revoked
 ↓
delete event
 ↓
客户端删除旧镜像
```

避免“服务端不给了，但手机里旧正文永久存在”。

同时确认：

> `/memory/list`、`/memory/changes` 是桌面/Runtime 面，不是 `/mobile/v1` Android API。

------

# I-b. P11-3 · Desktop Runtime Hardening

进入 P12（Mobile Contract Convergence）**之前**的桌面运行期修复阶段。

理由：P12 要把 `/mobile/v1/*` 冻结成 Android 的正式契约。如果桌面侧 canonical 域
还存在"生产进程入口没接线、浏览器绕过权威直写"这类问题，那么冻结下来的契约
本身就是空的 —— Android 会照着一条在真实启动链上返回 503 的路由实现。

计划文档：`.dsh-research/P11-3-implementation-plan.md`
初始计划为 7 个独立 commit；随审计推进已扩展（新增 3H）。

## 唯一组件事实源 ✅

`runtime/component-registry.js`（提交 `bd9dc0d`）已建立：

- id / 端口 / 身份探针 / 必需语义 / 状态↔reason 映射 / 健康聚合 / `restartable`
- `boot-state` 的 `COMPONENT_ORDER`、launcher 组件轴、runner 服务表与重启目标
  全部改为从它派生
- 新增 `GET /components` 实时视图（必须由运行中的 runner 进程回答 —— 只有它知道
  自己启动过哪些子进程）

**边界声明（registry 自身的注释明确写了）**：registry **不是** supervisor、
不是重启策略、不是恢复机制。它只声明事实，不启动/停止/重试/退避/恢复任何东西
（那是 P11-3C 的职责）。

### cleanup ✅ `9a19558`

launcher 不再维护自己那份端口解析器（commit subject：
*drop the launcher's own port parser*）—— 消除 registry 之外的第二份端口真理源。

## P11-3A ✅ `3ebb66e` 凭据铸造面收口

未配置 `IB_HOME_NODE_TOKEN` 时，以下**写入/铸造类**路径在 loopback 上也返回
`403 desktop-token-required`：

```text
/pairing/session
/devices
/device/revoke
/characters/publish
/mobile/v1/pairing/complete
```

读取类路径**有意**保持 loopback 匿名（属既有 D1 风险接受，不是遗漏）。

## P11-3B ✅ `bd9dc0d` 组件注册表

见上「唯一组件事实源」。

------

## P11-3C ✅ `f6b9a59` Bounded Crash Recovery / Component Supervisor

子进程反复崩溃时**有界**恢复（退避 + 上限 + 终态），不得无限重启。

实现落在 `runtime/component-supervisor.js`（状态机）+
`runtime/local-services-runner.js`（真正的 spawn / kill / probe）。

### 状态机

```text
healthy / starting / stopped / recovering / failed
```

封闭事件集合（未知事件视为调用方缺陷，**不静默吸收**）：

```text
start
health_fail
process_exit
restart_success
restart_failed
budget_exhausted
stop              ← 优雅关闭 / 控制面重启 / 操作员停止
stop_failed
```

恢复触发原因单独记录，以便区分"自己死了"与"活着但不再应答"：

```text
start / process-exit / spawn-failed / health-fail
```

### 有界性由四道独立闸门保证

`RECOVERY_POLICY`（`local-services-runner.js`）：

```text
maxAttempts       5
windowMs          10 * 60 * 1000   （10 分钟滑动窗口）
baseBackoffMs     1000
maxBackoffMs      60 * 1000        （60s 上限）
healthFailStreak  2
```

- **滑动窗口**：一个跑得久的组件不会因为"历史上崩过很多次"被永久锁死。
- **指数退避 + 60s 上限**：持续故障不会变成满 CPU 热循环。
- **`healthFailStreak = 2`**：一次慢探测不得重启一个正在正常工作的服务。
- **crash-loop lockout**：预算耗尽 → `failed`，**本进程内不再自动重试**，
  且**唯一能解除锁定的东西是真实健康证据**（不是时间，也不是调用方清标志）。

状态机没有"直接设置状态"的入口：**每一次回到 `recovering` 都必须经过
`authorizeAttempt()`**。

### 不算崩溃的情况（显式状态机决定，不是调用方的 `if`）

- **graceful stop 不触发恢复**
- **control-plane restart 不算 crash**
- 组件被有意停止 → `stopped`，而非 `recovering`

### restartable 目标

| 组件 | id | restartable |
| --- | --- | --- |
| 主界面服务 (Static) | `static` | ❌ 不自动恢复 |
| Bridge 后端 | `bridge` | ✅ |
| 后台主动消息服务 (Active) | `active` | ✅ |
| Home Node 聊天权威 | `homeNode` | ✅ |
| 后端重启控制面 (Restart) | `restart` | ❌ 不自动恢复 |
| Vision 高级可选组件 | `vision` | ❌ 不自动恢复（disabled 时不恢复） |

即 **bridge / active / homeNode 是 restartable targets**；
**static / restart / disabled vision 不自动恢复**。

### 观测面

- **`GET /recovery`**（runner 暴露）
- `restartCount`
- `lastRestartAt`
- `lastFailureReason`
- `recoveryState`
- 状态摘要 `{ healthy, starting, stopped, recovering, failed }`

### 控制面可用性

控制面**已提前启动**，避免"组件启动失败导致 `/shutdown` 永久不可达"——
否则一次坏组件会把整个进程变成关不掉的东西。

### 测试夹具教训（后续通用）

见下方「测试纪律推论（P11-3C 教训）」——多实例进程级夹具的身份必须来自
每进程独有的事实（路径 / 参数），不能来自共享环境变量。

## P11-3D ✅ `b1af1db` Tool Execution Guard / Total Budget

**已提交（`b1af1db`）**，并在 **P11-3D.1** 收口周期归属。

> 守门测试（本路线图修订时确认存在）：`tests/test_p11_3d_tool_guard_contract.js`、
> `tests/test_p11_3d_tool_execution_guard.js`、`tests/test_p11_3d_tool_guard_mutations.js`。
> 本节按阶段基线记为已提交；`tool-execution-guard.js` 的内部实现**未经 P11-3X-B
> 复验** —— 该阶段的边界是 runtime / DB 可靠性，全程未修改 tool guard。

已定位的三个具体缺口（作为该阶段的入题证据）：

- FC 循环 `maxRounds` **不可达**
- MCP-only 回合 `roundLocal` **不自增**
- 同 `name` + `args` **无去重**

交付的 guard 面：

```text
Tool Execution Guard
├─ round budget            单回合循环次数上界
├─ tool execution budget   单回合工具执行总次数上界
├─ retry budget            重试次数上界
├─ duplicate fingerprint    同 name+args 去重
├─ cycle timeout           整轮墙钟超时
├─ breaker reason          中断必须带可解释原因（不得静默截断）
└─ observability           预算消耗可观测
```

设计约束（继承既有纪律）：**中断必须是可解释的终态**，不得表现为
"模型突然不说话了"这类 silent fail-open。

## P11-3D.1 ✅ `574193a` Host-turn Tool Budget Convergence

**ONE HOST AI TURN = ONE TOOL EXECUTION CYCLE = ONE TOTAL BUDGET.**

周期 owner 是**宿主 turn**（单聊一个；群聊每个发言成员各一个），不是一次
`callApiChat*` 调用。每个开周期的 turn 拿一个独立 guard 实例
（`IBFC._newGuard` 是唯一分配点）。

明确禁止：全局 mutable guard、在 storage 里存活动周期、按「当前活动周期」推断归属、
XML 通道单独建第二个预算。

## P11-3X-A ✅ `5ab085e` Security / HTTP Boundary

P11-3X 的第一段：只做安全 / HTTP 边界，不碰性能、Moments、hydration。

本段真实修复：

- **named foreign Origin enforcement** —— 命名外来 Origin 从「读不到」变成「不可执行」
  （Bridge 路由层；与 `active/http.js` 等既有策略同一条规则，未新增模型）
- **Bridge `/status` 归入 token 线** —— LAN 模式（token 必填）下它此前仍匿名可读，
  而它暴露的正是 `/api/diagnostics` 被特意保护起来的同类信息
- **Home Node 桌面面 Origin 边界** —— `/migrate` 等原本可被外来 Origin 的简单请求盲写
- **memory viewer 的「缺省 vs 空值」区分** —— `?viewer=` 空值原本 fail open（返回含
  private 的完整镜像 / 完整变更流）；缺省完整镜像仍是 canonical 契约，未改
- **Bridge `/api/llm-proxy` 被命名外来 Origin 盲驱动** 由同一闸门覆盖

未处理（只提交证据与边界分析，未扩大范围）：

- **已接受风险**：`Origin:null` / 本地无 token 读写面 —— 按 `docs/DECISIONS.md`
  **D1（:13）** 接受，属该决策明确排除的架构级改造，留待 P12 决策
- **SEC-D1 / SEC-D2 债务**：由 **D1**（个人本地应用定位：companion 无鉴权 +
  null-origin 放行）与 **D2**（Bridge REST 无 token 鉴权是设计如此）两条决策产生的
  安全债务。本段只记录不改变；完整清单见 3X-A 阶段报告，不在本路线图重述

守门测试：`tests/test_p11_3x_a_security_http_boundary.js`（60 断言）、
`tests/test_p11_3x_a_boundary_mutations.js`（9 变异，全部 CAUGHT）。

## P11-3X-B ✅ `67c59be` Runtime / DB Reliability

P11-3X 的第二段：当 Runtime / Home Node / SQLite / 端口 / 进程出现故障时，能准确识别、
正确分类、稳定恢复或明确降级；**不允许把坏状态伪装成 healthy，也不允许把不同故障
混成同一类**。

本段真实修复（每条都有「修复前实测复现 → 最小修复 → 断言 → 变异承重」四段证据）：

- **health truthfulness**：Home Node 的 `/health` 在 canonical store 关闭时不再回答
  `ok:true`；新增 `serving` 与 `failure.category`，组件模型据此报 `error`
  （可达但干不了活），而不是 `healthy`
- **可达 ≠ 能干活**：组件注册表新增 `servingHealth` 判定轴；聚合与 boot-state
  不得再把 `store-closed` 洗成 healthy
- **隔离闸门**：只有**完整性结论**（`quick_check` 非 `ok`，或驱动明确说文件不是数据库）
  才允许改名隔离；READONLY / 权限 / busy / 磁盘满 / 打不开一律不动磁盘。
  修复前实测：一个完好库因 WAL 侧车路径被挡住而被当作损坏搬走，新的空库顶上，
  服务仍报 `open:true` + healthy
- **数据库失败分类**：新增唯一分类源 `runtime/db-failure.js`
  （`db-readonly` / `db-permission-denied` / `db-busy` / `db-locked` / `db-disk-full` /
  `db-corrupt` / `db-schema-too-new` / `db-open-failed` / `db-unavailable`），
  store、组件模型、boot-state 三方词表由断言钉住，不允许漂移
- **只读库在开库时就被发现**：读写预检 + 写入期分类，不再出现「打开成功、探针健康、
  每条写入才失败」
- **端口归属预检**（free / self / owned-component / foreign / unknown）：外部占用者
  被明确拒绝启动并给出类别与 pid，**绝不 kill 非本方进程**；身份谓词同时认绝对路径
  与仓库相对路径
- **重复 runner 在控制面启动阶段就明确失败**：修复前实测第二个 runner 会变成一个
  「有自己的 child、没有可用控制面」的孤儿进程，并且 exit code 是 0
- **根因传播**：child 的 stderr 尾巴被分类后带进 supervisor 的 `lastFailureReason`，
  终态同时回答「为什么死」（`db-readonly`）与「为什么不再试」（lockout），不再只剩
  `process-exit` / `budget exhausted`
- **库不能服务时回答 503**（原先 400 会把调用方引去修一个本来没问题的请求体）
- **探针理由写明真实端口与真实耗时**（原先写 `defaultPort` 与 `within 0ms`）
- **发行包闭包**：新增的运行时分类器已登记进 release manifest（manifest 是逐文件
  白名单，不是 glob）

守门测试：`tests/test_p11_3x_b_runtime_db_reliability.js`（53 断言）、
`tests/test_p11_3x_b_boundary_mutations.js`（12 变异）。

## P11-3X-C ✅ `1a64705` Performance / Context Budget Audit & Closure

P11-3X 的第三段：对**当前 AI 回合**做基于真实生产路径的性能审计，只修能被运行时证据
证明的问题。纪律：MEASURE → CLASSIFY → PROVE → MINIMAL FIX → FALSIFY → REGRESSION。

**不是"把 IB 优化得更快"**，而是回答：一个真实 AI host turn 里到底有多少 context 被送进
模型、到底做了多少重复 IO、用户什么都不做时 IB 还在做多少工作。

### 建立的东西（新机制，唯一事实源）

`assets/js/context-budget-core.js` —— **canonical context budget**（纯函数、零 DOM、Node 可测）：

- `estimateTokens`：**全仓唯一的估算器**（CJK≈1 token/字、其余≈0.33）。`communication.js` 的
  `_cacheTok` 现在只是它的委托薄壳，算法本体只有一份（`core.onlyOneEstimatorImplementation` 守住）。
  它是 conservative estimator，不假装是 provider tokenizer。
- `APP_CEILING_TOKENS = 64000`：**应用级天花板**，不是模型能力表。本阶段明确**不**手抄
  GPT/Claude/DeepSeek 的 context window；provider capability 留作扩展点（`plan/planParts`
  接 `ceiling`/`reserve` 参数）。
- 三档预算：`totalBudget` / `reservedOutputBudget`（= 本回合 `_chatMaxTokens(cfg)`，clamp 1024..16384）
  / `inputBudget`，所有输入块**共享** `inputBudget`。
- 不可丢：system/persona 身份 · 当前用户消息 · 工具定义（`NON_COMPRESSIBLE`，梯子里不可能出现它们）。
  可压缩（让位顺序）：`history → memory → moments → thread → activity → understanding`，每级有下限。
- `irreducible`：不可丢部分本身超预算、或梯子到下限仍压不进去 → **不做任何裁剪**，只如实上报
  （那属于产品决策：缩 persona / 减工具 / 换模型）。

落地方式：**不新增任何截断器**。宿主回合在 producer 运行前用各级**既有上限**（worst case）算出额度，
再把 `keepFraction` 作用到那些**既有参数**（`maxChars`/`maxThreads`）。天花板之下每一级恒为 1，
producer 拿到的是与改动前逐字相同的调用 —— 机制唯一存在，正常使用中零可观察变化。

### 实测现状（修复前后的真实数字）

| 项 | 修复前（实测） | 修复后（实测） |
|---|---|---|
| 一次普通单聊回合的 IndexedDB 操作 | **69** | **47** |
| `favorites` 全表扫描 / 一次聊天面板打开 | **50**（每条渲染的气泡一次） | **1** |
| 单次 `favorites.has()`（2000 条收藏） | 21.2 ms × 50 次 ≈ 1.06 s | 每次渲染只付一次 |
| `getThreadContext` 的 memories 全表读（40 条线索） | **41 次 / 552 ms** | **2 次 / 94 ms** |
| 记忆激活（2000 条记忆、65 条选中） | 65 读 + 65 写 = **130 个事务** | 65 个事务（读-改-写同事务） |
| 每回合 `posts` 全表读（300 篇 ≈ 144KB） | **2 次** | **1 次** |
| 空闲唤醒（可见，含入场动画期） | **584/min** | 349/min（入场期）/ **~55/min（稳态）** |
| 空闲唤醒中的亚秒级引导轮询 | 三个（200/400/500 ms），其中两个**无上限** | 只剩 calendar 那个**自带 60 s 上限**的；两个无上限的改为 3 s 退避 |
| 一个请求的输入规模（估算 token） | normal 1,139 · 1000 条历史 1,147 · 2000 条记忆 2,130 · 最坏混合 23,801 | 同（天花板之下不改行为） |
| 无界块 | persona 200k 字符 → system **202,051 est tok**（无任何上限） | 同（如实计量 + 如实上报；缩 persona 属产品决策） |

### 六条 CONFIRMED（每条都有"修复前实测复现 → 最小修复 → 断言 → 变异承重"）

1. **无总量预算**：全仓零 `contextWindow|maxInputTokens|tokenCount|estimateTokens` 命中；
   唯一的 token 函数只喂日志字符串。→ 建立上面那套 canonical budget。
2. **`favorites.has()` 全表扫描，且每条渲染的气泡调用一次**（keyPath 是随机 id、sourceId 无索引，
   本阶段禁止 schema 变更）→ 单飞（single-flight）读取：同一时刻在飞的那次由所有并发调用共享，
   settle 即丢弃共享（**不是缓存**，无陈旧窗口），本地写入显式结束共享。
3. **`getThreadContext` 每条线索各做一次 memories 全表读**（O(线索数) 串行）→
   `_ibAttestDerived(..., preloaded)`，一次读、所有线索共用同一一致快照。存证判据一字未改。
4. **记忆激活"先 dbGet 再 dbPut"两条记录两个事务** → 新增 `window.dbUpdate(store,key,mutator)`
   （读-改-写同一 readwrite 事务）。仍逐条处理、读取发生在写事务内部（只会更新，不会陈旧写）。
5. **每回合 `posts` 读两遍全表** → 预读结果经 `buildSiteContext(signals,{posts})` 复用。
6. **两个无上限的 DOM 条件引导轮询**（`basement.js` 等 `G.viewport` 400 ms、`game_room.js` 等
   `#splash.hidden` 500 ms）→ 前 10 秒保持原频率、之后 3 s 稳态，收敛性不变（沿用 `calendar.js`
   既有的"引导轮询必须有界"约定；**不加** `document.hidden` 守卫，因为完成条件是 DOM 状态）。

### P11-3D.1 兼容性（冻结不变量）

`ONE HOST AI TURN = ONE TOOL EXECUTION CYCLE = ONE TOTAL BUDGET` **仍然成立**：
新模块不改周期归属（周期 owner 仍是宿主 turn）、不开第二个 turn identity、不让 XML/native FC
分裂预算；预算在宿主回合**记一次**（单聊/群聊各一条），工具定义**永不**进梯子、超预算时也不消失
（真实回合实测：把天花板压到 12000 后工具标记与工具定义数组逐字不变，persona 与当前用户消息
同样逐字不变）；`tests/test_p11_3d1_xml_guard_compat.js` 与 `tests/test_p11_3d_tool_execution_guard.js` 全绿。

守门测试：`tests/test_p11_3x_c_context_budget.js`（测量表 + 修复断言，支持按节运行）、
`tests/test_p11_3x_c_boundary_mutations.js`（13 变异，每个都必须让**指名的**判据变红）。

### 登记但本阶段不修（按未来阶段归类）

- Moments canonical store / `openAll()` 不开 momentsStore → **P11-3E**（已关闭，`2d184c6`）。
- hydrate 空远端覆盖 → **P11-3F**（已关闭，`bb3785d`）。
- unacked event retention / retry（`mobile-gateway` 的 2.5 s event pump 在有订阅者时每 tick 一次
  `changesAfter` 查询；无订阅者时早退、不扫库）→ **P11-3G**（已关闭，`327dbfb`；
  该 pump 走的是 **chat** store 的 change_log，与 moments 镜像投递是两条不同的读口 ——
  本阶段关闭的是 **moments** 那条；chat 侧 pump 的 `eventCursor` 仍是纯内存且只推给
  已订阅者，无订阅者时早退，因此不存在"永久占据窗口"的形状）。
- `active/http.js GET /events` 的未 ack 事件窗口（同形状、不同面）→ **新登记**，未修。
- Windows 优雅关闭 / `ib-stop` / installer → **P11-3H**（未动）。
- `Origin:null` / token architecture → 已登记的安全债务，不在 3X-C 扩大。
- **Bridge JSON 持久化健康**：`saveList` 失败只 `console.error`、`/health` 恒 `ok:true`；与性能无直接
  关系，只登记。
- 其他消费者（博客留言 `post.content` 无上限、摘要输入 transcript 无上限、workspace 续写的
  `oldContent` 无上限、Middle Brain Astra 的 context message 无上限、moments 线程评论条数无上限、
  `IBFC._buildTools()` 的工具条数/总字节无上限）**只登记不修**：它们的总额度可以直接复用本次建立的
  `IBContextBudgetCore.planParts()`，但把 11 个消费者逐个接上属于各自的阶段，不在 3X-C 吞掉。
- `game/game_room.js` 的 rAF 主循环没有 `document.hidden` 守卫、`glass-ripple.js` 的 rAF 在隐藏时
  每帧空转但不 `cancelAnimationFrame`、`_ibGuardInit()` 无重入守卫（今天靠 `init()` 只跑一次）——
  都只登记（游戏/rAF 优化不属于"AI 回合"这条线）。

## P11-3E ✅ `2d184c6` Moments Canonical Runtime Closure

**目标不是"让 moments API 看起来能用"，而是让"注册了 moments 能力"与"canonical
moments store 实际已打开并可承担职责"成为**同一个事实**。**

### ONE MOMENTS AUTHORITY

> **HOME NODE 的 canonical moments store（`services/home-node/moments-store.js`，
> 与 chat / memory / understanding 同一个 `home-node.db`）= 唯一权威。**

浏览器 `moments-authority.js` 是**客户端**（canonical / mirror / off 三态），
IndexedDB 的 `moments` 是**镜像**；mobile 设备面**没有**任何 moments verb
（`deviceVerbs: []`）。本阶段**没有**新增第二套 store / 第二个 sync 协议 /
schema 变更 —— 只把既有权威的生命周期收口。

### P11-3E Phase 0 重新取证：旧结论里哪两条必须修正

Phase 0 沿真实生产链（`runtime/local-services-runner.js` → spawn
`services/home-node-service.js` → `require.main` → `openAll()`）重新取证，
**旧结论两条不成立、一条成立且比原先描述的更严重**：

| 旧结论 | 重新取证结果 |
| --- | --- |
| ③ 生产 `openAll()` 漏开 `momentsStore` | **成立**。私有端口 + 私有数据目录实测：`/moments/list` → 503 `store-closed`；`/moments/changes` 与 `/moments/visible` → **400**（把基础设施故障报成"请求有问题"）；`/moments/migration` → **200**（谎报：读不到水位与"水位是空的"同一个响应）；磁盘上从不出现 moments 表。 |
| ② `moments.js` 8 处直写、零权威调用方 | **作为"归属缺陷"成立**，但**作为"写路径因此堵死"的因果不成立**：`dbPut('moments')` 被 `home-node-bootstrap.js` 的守卫正确拦下，而拦截本身把请求导向权威——所以写路径的**真正**断点在后端，不在浏览器。 |
| ① 守卫在 http 承载下无条件生效 | 成立，且是**设计意图**（`momentsWriteClosed() = authorityEffective()`；`file://` / mirror / off 下不拦，那是官方回滚路径）。 |
| （新增，旧结论没写） | **`POST /moments/record` 在 store 打开时也必定 500**：网关里 `const record = body.record` 遮蔽了同名日志函数，`record('info','moments-put',…)` 抛 `record is not a function`，被 `http.js` 兜底捕获成裸 500 —— 一条**已经提交**的动态被报成失败。仓库里没有任何测试打过这个 verb。 |

**结论：③ 与新增的 500 必须先修，否则 B1/B2/B3 的取舍都是在估一个不存在的基线。**

### 建立的东西

| 件 | 位置 | 说明 |
| --- | --- | --- |
| 生产 open/close 闭包 | `services/home-node-service.js` | `openAll()` 打开 moments store；`shutdown()` 关闭它。**唯一**打开入口 `openMomentStore()`（开库事故记进探针，不静默吞） |
| store 失败分类（唯一一份） | `services/home-node/http.js` | `resolveStoreFailure()`：`store-closed` + `db-*` 闭集 → 503；终态（corrupt / schema-too-new / unavailable）→ 500。词表**复用** `runtime/db-failure.js` 与 `component-registry` / `boot-state` 的既有 REASON，**没有第二套错误词表** |
| 失败探针 | `services/home-node-service.js` `createMomentStoreFailureProbe()` | 回答"这个 store 为什么不能服务"—— `isOpen()` 只能覆盖"开过又关了"，打不开的那一半只有抛出的错误记得 |
| 分类注入 | `home-node-service.js` → `gateway.useStoreFailureResolver()` | 分类只有一份：http.js 实现，装配层注入网关。注入缺席时行为退回改动之前（不猜） |
| 写路径修复 | `services/home-node/mobile-gateway.js` | `record` 遮蔽改名 `moment`；`/moments/*` 的 store 层失败改为 503/500 带类别，`revision-conflict` 仍 409，schema 级拒收仍 422 |

### health 语义（与 P11-3X-B 同一模型，没有第二套）

`/health` 与 `/status` 的 `serving` 现在覆盖**全部** canonical store（chat + moments），
`failure.category` 取声明角色（chat）的那一条，并新增 `stores[]` 如实列出到底是哪个域
不能服务。**先证明 production assembly 正确，再把 readiness 纳入 health** ——
顺序是刻意的：P11-3X-B 当时不纳入，正是因为那时纳入会把"已知装配缺口"变成永久误报与恢复环。

- store 关闭 → `serving:false`、`ok:false`、`category:'store-closed'`，**HTTP 仍 200**（reachable 与 serving 是两件事）；
- 库打不开（如 schema 过新）→ 类别 `db-schema-too-new`，`/health` 200 + `serving:false`，`/moments/*` **500**（终态，重试不会好）；
- 一个派生域起不来**不得**让整台节点连聊天都不服务（域隔离实测成立）；
- supervisor 因此第一次能看到真实失败；重启预算与 lockout 由 P11-3C 既有策略兜住，不新建恢复环。

### 持久化 / parity / 失败语义（实测）

- **重启 ×3**：create → update → delete 全部跨真实 SIGTERM/重启存活；墓碑行落盘
  （`getRecordAny().deleted === true`）且不出现在任何生产读口；`change_log` 跨重启保留
  `kind='delete'`；增量 `changes?cursor=` 仍以 `deletes[]` 报出删除；`moments_revision`
  独立命名空间、跨重启连续。
- **desktop/mobile parity**：桌面写 → Node 读立即可见且 revision 前进；`/mobile/v1/moments/*`
  与 `/mobile/moments/*` 都不存在；`/security` 的 `momentsPolicy`（`stored:true` /
  `servedToDevices:false` / `deviceVerbs:[]`）与真实路由逐字一致；设备面出站字节里不含动态正文。
- **失败语义 A–H**：store 未开 / 运行中被关 / 开库失败 / DB 不可写与 busy / malformed
  request / restart 恢复 / 双实例-端口冲突 —— 全部实测。**基础设施失败绝不洗成空列表或 200**；
  请求层问题（缺 record / 空内容 / 不可归属 / 坏 id）仍 400/422，两类可区分。

### 测试与反证

- `tests/test_p11_3e_moments_canonical_closure.js` —— **103 项**，A–J 十节，
  含**真实 spawn `services/home-node-service.js`**（私有端口 + 私有数据目录 + 内置 Node）
  与真实重启、真实 SIGTERM；零 mock store。
- `tests/test_p11_3e_moments_mutations.js` —— **11 / 11 CAUGHT，0 escaped**。
  变异全部发生在**私有副本树**里，原仓库逐字节零漂移（7 文件 SHA-256 复核）：
  M1 `openAll()` 再漏开 · M2 health 不认识 moments readiness · M3 closed store 当空集合 ·
  M4 网关改读第二份 authority · M5 shutdown 漏 close · M6 重启换新库 · M7 写不落盘 ·
  M8 墓碑不持久化 · M9 DB failure 洗成 400 · M9b 开库类别被吞 · M10 发行清单漏依赖。
- 过程中由变异抓出**两处自己的缺陷**：`isStoreLevelError()` 定义后从未被调用（死代码，
  M9 因此第一次 MISSED），以及 M2/M9 第一版的变异方向根本没碰到被测路径 —— 已修。

### 测试盲区（P11-3E 关闭的主项）

「http 承载 × authoritative moments」这个唯一生产态此前**零覆盖**：`test_moments_browser_authority.js`
跑在 `file://`（官方回滚路径），守卫只在 `:233-258` 用结构性注入验证，
`openAll` 在全仓 tests 中零引用。现在生产启动路径与真实 store 由专项测试直接钉住。

### 登记但本阶段不修（按未来阶段归类）

- `moments.js` 8 处直写仍走守卫拦截路径 → **B1 未做**（属于浏览器侧收口，本阶段只关闭后端生命周期）。
- hydrate 空远端覆盖本地 → **P11-3F**（已关闭，`bb3785d`）。
- companion ingest 失败不 ack / 事件无限重投 → change-log 投递那一条**已由 P11-3G（`327dbfb`）关闭**；
  companion / proactive 事件面（`active/http.js GET /events`）的**同形状窗口仍开放**（新登记）。
- Windows 优雅关闭 / `ib-stop` / installer → **P11-3H**。
- **`/status` 在 chat store 关闭时回答 500 `internal-error`**（`store.meta()` 在关闭的库上抛）→
  P11-3X-B 范围，本阶段只登记（已写成 `D10` 断言 + 运行时 note）。
- memory / understanding 域的同款 store-closed → 400（网关 `page.error` 直通）→ 只登记，
  不在 3E 扩大；分类器已经可以被它们复用。

## P11-3F ✅ `bb3785d` Hydration / Mirror Safety

**目标不是"让 hydrate 不去覆盖本地"，而是"让破坏性替换只在权威真的说了话、
并且说完了的时候发生"。** 两个极端都是错的：无证据清空镜像，与"为了保护本地
所以永远不允许远端空状态删除本地数据"。

### ONE CANONICAL REMOTE STATE → ONE LOCAL MIRROR

| 不是同一件事 | 说明 |
| --- | --- |
| **ONE AUTHORITY ≠ LOCAL MIRROR** | 权威是 Home Node 的 canonical moments store；浏览器 IndexedDB 的 `moments` 只是镜像。它**可以**被权威整表替换，但**永远不能**反向成为事实源。 |
| **remote unavailable ≠ authoritative empty** | 503 / 超时 / 连接被拒 / 坏信封 / 缺字段 / 截断页，**都不是**"远端说没有"。 |
| **authoritative empty ≠ 危险** | 远端**明确成功且声明完整**的空快照**必须**能清空镜像。禁止的是"没有证据的清空"。 |

### 修复前的真实 failure chain（Phase 0 重新取证）

真实 spawn 生产入口（私有端口 + 私有数据目录 + 内置 Node）+ 真实 HTTP +
真实浏览器传输 + 真实 `moments-authority`：

```text
authority 有 250 条
GET /moments/list?limit=4000 → 200，200 条，**没有任何截断信号**
   （服务端把 limit 夹在 PAGE_MAX=200 上且不报告；/memory/list 早在报 truncated）
hydrate → {ok:true, hydrated:true, seeded:200, cursor:250}
镜像 → 200 条（1 条本地遗留行被清掉），50 条权威行**永久丢失**
   —— cursor 已推进到 250，增量再也不会把它们补回来；而所有标志都是绿的

200 {"ok":true}（无 payload）      → records undefined → `|| []` → 镜像被清空
200 {"ok":true,"payload":{}}      → 同上
200 records:null                  → 同上，且 cursor 跳到 9
200 truncated:true（服务端明说）   → 镜像被替换成那一页
真实 503 store-closed / 连接被拒    → 镜像确实保住了，但 status.degraded=false、
                                    degradedReason 停在 'not-probed'、lastError=null
```

最后一条尤其值得记下：**"没清空"不等于"做对了"** —— 它会以"一切都好"的形状
把一次失败的 hydrate 呈现给所有消费者。

### canonical hydration contract（本阶段建立的判据）

破坏性整表替换**只**在下面四条**全部**成立时被授权（每一条都看服务端**明说**的字段）：

```text
① ok === true                 传输层没有把它合成为失败
② Array.isArray(records)      字段存在且是数组（不是 undefined / null）
③ truncated === false         服务端**显式声明**这一页是完整的
④ typeof revision === number  且 isFinite（0 是合法版本：全新库）
        ↓
   validated complete snapshot → 原子镜像替换 → 才推进 hydrated/cursor/mirrorRevision
```

不成立时：**不碰镜像**，`hydrated` 不许变真，`cursor` / `mirrorRevision` 不许前进，
只如实记 `degradedReason` / `lastError`。失败分类复用既有闭集（服务端的
`store-closed` / `db-*` 原样转发，客户端**不复制**服务端的词表；传输层已产出
`timeout` / `invalid-response` / `home-node-unreachable`），本阶段只新增两个
契约内新状态的码：`incomplete-snapshot` 与 `superseded`。

**为什么 `truncated` 必须是硬判据**：`/moments/list` 是镜像播种的**唯一**读口且有上限。
缺了它，"远端只说了一半"与"远端说完了"在客户端是**同一个形状** —— 这就是上面那次
静默截断。服务端因此新增 `truncated`（字段名与语义**复用 memory**，不新造），
并把镜像播种的上界从 `PAGE_MAX(200)` 改成 `MIRROR_SEED_MAX`。

### 原子替换

`moments` 的镜像替换原先是"getAll 算 stale → 逐条 `dbDelete` → 逐条 `dbPut`"——
**一串独立事务**，中途失败会留下半旧半新的镜像。现在改用 `core.js` 的
`replaceMomentsMirror`：clear + put 排进**同一个** readwrite 事务（与
`replaceMemoryMirror` / `replaceChatMirror` 同形）。

真实 Chrome 取证时**又抓出一个更深的缺陷**：catch 里只 reject、**没有 abort** 时，
一次同步抛错（结构化克隆失败）之后 IndexedDB 会把**已排队**的 clear 与前面的 put
照常提交 —— 实测 `clear + put(a) + put(不可克隆)` 之后镜像里只剩 `a`，
既不是旧镜像也不是新镜像。同一个接缝对象里的**五个**写入器都补齐了显式 `abort()`。
（I9 断言：失败的整表替换之后旧镜像**完整保留**。）

### race / supersession 语义

- **串行化**：所有会改镜像的路径（hydrate 提交 / 增量 changes / put / remove）
  排在同一条 promise 链上 —— "检查代次"与"真正落盘"之间因此**没有窗口**；
- **`hydrateGen`**：只有最新一次 hydrate 有权提交。旧的那次即使后到也只会得到
  `superseded`（`reason:'newer-hydration-started'`），不写、不改版本；
- **`mirrorRevision`**：已落盘到镜像的最高权威版本。晚提交的**旧快照**
  （`verdict.revision < ctx.mirrorRevision`）同样被拒
  （`reason:'stale-snapshot'`）—— 这是 hydrate 与增量 `changes` 竞争时的唯一判据；
- **游标只许前进**：`cursor` / `mirrorRevision` 都取 max，回退的游标会让已应用的
  变更被反复重放，并让水位与镜像内容脱节。

实测（J/K 两节）：旧 hydrate 后到不覆盖新结果、`replaceAll` 只发生 1 次；
真实快照被扣住、增量先跑完之后再放回，旧快照被拒且镜像没有回退。

### degraded / hydrated 状态语义

`degraded` 的判据收敛成**一处**（`isDegraded()`，`status()` 与读路径共用）：
`!authorityEffective() || remoteOnline === false || degradedReason != null`。

- 成功之后：`hydrated:true` / `degraded:false` / `degradedReason:null` /
  `lastError:null`，且 `cursor === mirrorRevision === 权威 revision`；
- 失败之后：`degraded:true` + **真实原因** + `lastError`，而 `hydrated` **保持原值**
  （镜像确实还是上一次成功的样子 —— 不许谎报成"没有镜像"，也不许谎报成"没事"）；
- 初始态是**诚实的未知**（`degradedReason:'not-probed'`），不是"健康"。

### 测试与反证

- `tests/test_p11_3f_moments_hydration_safety.js` —— **120 项**，A–L 十二节 +
  一个登记节。真实 spawn、真实 HTTP、真实 AbortController 超时、**真实 IndexedDB
  （file:// 页面上跑 core.js 的实际替换原语）**；零 mock store。
  A 正常替换 / B 权威空清空 / C 503 / D 终态 db-*  / E 连接被拒 / F 超时 /
  G 十三个坏形状 / H 截断页（拒绝而不是替换成第一页）/ I 原子性 /
  J 并发 hydrate / K hydrate×changes / L 重连 / M 状态一致性 / N 禁止写法 / R 登记项。
- `tests/test_p11_3f_hydration_mutations.js` —— **11 / 11 CAUGHT，0 escaped**，
  baseline GREEN，原仓库 7 文件 SHA-256 逐字节零漂移（变异全在私有副本树内）：
  M1 缺字段回退成 `[]` · M2 503 仍 replaceAll([]) · M3 authoritative empty 被错误保护 ·
  M4 丢掉完整性闸门（截断页立刻 mutate 镜像）· M5 退回非原子替换 ·
  M6 失败后 hydrated=true · M7 degraded/lastError 被清空 · M8 旧 hydrate 覆盖新的 ·
  M9 失败后 cursor 仍前进 · M10 把镜像当事实源 · M11 服务端不再如实声明 truncated。

### 测试盲区（P11-3F 关闭的主项）

「hydrate 的**输入**是坏形状」这一整类此前零覆盖：`test_home_node_client_envelope.js`
证明的是**信封解包**不再产生 `undefined.records`，但 hydrate 自己那一行
`replaceAll(page.records || [])` 以及"截断的页也算完整快照"从来没有任何断言。
本阶段第一次让"镜像被清空 / 被截断 / 被旧快照回退"这三件事都有一条指名判据。

### 登记但本阶段不修（按未来阶段归类）

- **未迁移的浏览器遗留动态会被 boot 的首次 hydrate 清掉**：`migrate()` 的资源是
  浏览器镜像，而 boot 的首次 hydrate 先于任何 migrate 执行；权威为空时整表替换会
  把遗留行一起清掉。**H4 要求如此**（拒绝"本地非空 + 远端空就不覆盖"这条捷径），
  正确修法是让 migrate 与首个 hydrate **定序**（迁移水位）→ migration / upgrade 边界。
  已被 R1–R3 断言为**已知债**，任何无意变化都会变红。
- **memory / understanding / chat 各自持有独立的 hydrate 实现**：`page.records || []`
  同款兜底仍在；memory 甚至**已经知道** `truncated` 却只拿它记 `hasFullHistory`、
  仍然用截断页替换镜像。它们与 moments **不共用** hydration 原语，因此
  "不修就无法保证本阶段不变量"不成立 → 按硬边界只登记、取证、分类。
  已被 R4–R6 断言。
- `moments.js` 仍有 8 处直写走 `momentsWriteClosed` 守卫拦截路径（B1 未做）。
- `/status` 在 chat store 关闭时回答 500 · memory/understanding store-closed→400 ·
  `moments.js` 有两处**裸 `db.transaction` 读**绕过权威适配层（只读、非破坏）——
  均沿用 P11-3E 的登记。

### 下一阶段

**P11-3H · Installer Lifecycle Convergence**（`ib-stop.js` 的 serviceTable 与
component registry 对账）。

## P11-3G ✅ `327dbfb` Change-Log Delivery Closure

**Ack / Retry / Poison Event / Retention / Bounded Replay。**

> ⚠️ **本条的早期框架与最终执行范围不同，必须先说清。**
> 本节原先写的是 "`active/http.js` 侧给未 ack 的事件加投放上界"，指向
> **companion / proactive 事件面**。P11-3G 执行时核对后确认：真正让"一个永久失败的
> event 永久占据 `limit=100` 窗口"这件事在**生产上成立**的那条路径，是
> **canonical change log → 浏览器镜像**的增量投递（`/moments/changes` →
> `moments-authority.applyChanges`）。于是本阶段关闭的是**投递**这一层。
> `active/http.js` 的 `GET /events` 确有**同形状**的第二处窗口（按
> `!event.acknowledged` 过滤、按 `sent_at` 升序、`limit` 上限 100、没有 attempts /
> 终态 / 回收）,它是 companion 面、有自己的 ack 语义与移动端契约 ——
> **登记在案，本阶段不修**（见下「discovered but NOT fixed」）。

### 目标

```text
ONE CHANGE EVENT → BOUNDED DELIVERY → EXPLICIT OUTCOME → NO PERMANENT HOL BLOCKING
```

并且**绝不**把这些压成一个 boolean：

```text
ACKNOWLEDGED ≠ APPLIED ≠ FAILED ≠ RETRYABLE ≠ TERMINAL
```

### 修复前的真实失败链（私有 Home Node + 真实 HTTP + 真实 authority）

| # | 事实 |
|---|---|
| ① | `applyChanges` 把所有 upserts 串成一条 promise 链，**第一个失败即整页拒绝**；`cursor` 只在**整页成功**时前进 |
| ② | 窗口第一条永久失败 → 每轮 sync **只尝试那一条**（实测 `put=1 / putFail=1`），cursor 恒为基线，服务端每轮发回同一个 `limit=100` 窗口且 `hasMore=true` → **后段永久不可达** |
| ③ | 中间某条失败 → 失败点**之前**的 event 已逐条落盘（部分应用是真实的），失败点**之后**一条都不被尝试；下一轮从第 1 条整窗重放 |
| ④ | **没有任何 attempts 计数**（源码里不存在该状态）→ 重试无上界，"重启归零"无从谈起 |
| ⑤ | 驱动**解析成 `false`**（生产 driver 对缺 id 的行就是这么返回的）被当成成功 → cursor 越过一条**从未落盘**的 event → **静默丢失** |
| ⑥ | change_log **从不回收**（源码里没有 DELETE），实测涨到 557 行 |
| ⑦ | `changesAfter` 的日志行与逐条 `getRecord` 是**一串独立读**：一页可能混着"日志说 revision 5、内容已是 9" |
| ⑧ | 客户端投递状态是**纯内存**（`ctx.cursor`），重启即消失 |

### 投递状态模型

| 状态 | 含义 | 存在哪里 |
|---|---|---|
| **PENDING** | 已读到、还没有持久结论 | 不单独存：它就是"窗口里、cursor 之上、不在 pending/terminal 里"的那些 |
| **APPLIED** | 该 event 的镜像写入**已经持久提交** | 不单独持久化 —— **镜像行本身就是证据**，而 put-by-id / delete-by-id 使重放幂等；存第二份只会得到一份能与镜像漂移的事实 |
| **RETRYABLE_FAILURE** | 应用失败且 `attempts < 上界`（退避中） | `meta['delivery:moments:desktop-mirror'].attempts[revision]` |
| **TERMINAL_FAILURE** | 应用失败且预算用尽，或**结构上不可能应用** | 同键的 `terminal[]`（**有界**诊断环），带 `resolvedBy: 'snapshot'` |

**ACK 的精确含义**（本阶段最容易被写反的一条）：

```text
ACK(W) = consumer 对 revision ≤ W 的**每一个** change event
         都已经得出**持久结论**（applied 或 terminal）

它 **不** 证明：HTTP 200 · 事件被读过 · 事件被尝试过 —— 那三件事都不是结论。
服务端只需要 W 一个数，且只拿它做一件事：决定 change_log 哪些行可以回收。
```

`W` 的三条性质（都可测）：**只在一个 event 得出持久结论之后**推进（因此"先 ack 再
apply"这个唯一会真正丢数据的顺序**不可能**出现）· 只沿**连续前缀**推进（前缀里有一个
还是 pending，W 就停在它前面）· **单调**（回退的结论取 max 吃掉）。

### crash consistency

```text
apply → 持久结论   之间 crash：**允许重放**，重放必须幂等（镜像先写、状态后写；
                   状态落后于镜像永远是安全方向）
持久 ack → apply   **禁止**：那是真正的丢数据窗口
```

实测：F 节在"apply 成功但状态写入未发生"之后重启重放 —— 不产生重复行、镜像内容**逐字节
相同**、cursor 补上；G 节在"已读取但一条未应用"之后重启 —— event **不丢**。
H 节还如实记录了一个**架构事实**：一次页面重载会先走 boot hydrate，而一次成功的快照会把
`≤ snapshot revision` 的待办**整体结案**（比"继续重试"更强）—— 因此"重启后要不要继续
重试"在生产路径上根本不成立；持久 attempts 在**实际消耗它的那条路径**上被验证为只减不增
（H5/H6 直接驱动投递层）。

### retry policy

刻意**不**复制 P11-3C 的 supervisor（那是进程恢复，不是投递重试），也**不**与 bootstrap
的 `withRetry`（同一次调用内的毫秒级重试）共用状态 —— 这里是**跨 sync 轮次、可持久**的。
复用的是**纪律**：上界有限且构造处夹紧（`Infinity/NaN/负数` 一律回落到默认）、退避**永远
不为 0**（零退避是穿着策略外衣的忙循环）、只有**真实的失败尝试**才 +1（被退避挡下的轮次不算）。

```text
maxAttempts = 4（hard clamp 8） · base 500ms · cap 30s · 终态诊断环 20 条
分类（封闭词表，未知错误按"这一条自己的问题"处理，但上界照旧）：
  event-rejected   DataError / DataCloneError / ConstraintError / TypeError / SyntaxError
  mirror-quota     QuotaExceededError
  mirror-unavailable InvalidState / Unknown / Abort / Version / NotFound / NotAllowed
  mirror-not-written 驱动显式解析成 false（没有写）
  event-inapplicable 缺 id / 未知 kind / revision 非法 → **一次也不重试**
```

**attempts 何时 +1**：一次真实失败的应用。**duplicate delivery 是否 +1**：是（那确实是
又一次真实的尝试）。**成功/终态之后**：从 pending 里删除。

### poison event / 队头收口（本阶段的核心验收点）

一页 event 在**第一个可重试失败**处停下，**但终态不是失败** —— 终态是结论、cursor 已经
越过它，所以本页**继续**。两条一起才成立：

- **停**：避免一次**镜像级**故障把整窗 event 全部烧成终态（那是比队头阻塞更糟的失败）。
  代价是健康事件最多等 `maxAttempts` 轮 —— 而且是**有界**的；
- **继续**：`attempts` 用尽 → 终态 → cursor 越过 → 本页剩余 event 照常应用；
- **终态 ≠ 丢数据**：终态意味着"镜像少了这一条"，因此随即用**快照**把它补回来 ——
  这是复用 P11-3F 的 `hydrate`（契约一字未改），不是新造恢复机制。

可观测性（Phase 4 要求，且**不得**携带正文/payload/凭据）：
`revision · kind · recordId · attempts · maxAttempts · error · category · detail ·
lastAt/at · state · resolvedBy`。

### retention contract

**一个 change event 什么时候可以安全删除？** 只有一个判据：

```text
revision ≤ **全体已注册消费者投递水位的最小值**
```

不是 `age > N days`，也不是 `revision < currentRevision` —— 两者都会删掉"消费者还没得出
持久结论"的事件，那在客户端表现为**镜像永久少一条而所有标志都是绿的**。
**没有水位 → 一行都不删**（fail-safe）：日志可以增长，这是"不知道消费者走到哪里就删"的
诚实代价。触发挂在 **ACK** 上（新容量只可能由消费者前进带来），判据是 **O(1)** 的
MAX-MIN 跨度（不是每次写入都 COUNT 一遍日志），单次批量有上界。

**多 consumer 不被假装支持**：边界取已注册水位的 **min**，因此多一个消费者只会更保守。
从未 ACK 过的消费者的契约含义是"它必须从**快照**开始"。推论（可证）：
**一个 ACK 过的消费者不可能看到回收造成的空档**（`retainedFrom ≤ cursor + 1` 恒成立），
所以空档判据是 **defense in depth** —— 它守的是"确认记账丢失/回滚、或将来的晚到消费者"。
L 节**直接驱动**它（并如实标注"当前生产路径上不可达"），M10 证明它承重。

### snapshot 与 change-log 的职责边界

```text
CANONICAL SNAPSHOT（/moments/list）= **恢复权威**
CHANGE LOG（/moments/changes）      = **有界增量传输**
```

日志**不是**第二 authority、**不是**永久历史、**不是**审计日志。因此"历史被回收后怎么
恢复"的答案永远是**快照**。L 节实测：先用真实 store 回收掉一段日志，再在同一 data dir 上
起真实 Home Node —— 一个**没有持久投递状态**的新消费者靠快照收敛、一条不缺。

### 测试与反证

- `tests/test_p11_3g_change_delivery_closure.js` —— **127 项**，A–R 十九节：
  happy path · 头/中 poison · transient · permanent（有界）· duplicate replay ·
  crash-before-apply · restart 持久性 · tombstone（幂等/可重试/终态）·
  long stream（250 条 / 窗口 100）· retention · authoritative rebuild ·
  可观测性与**脱敏** · forbidden shapes · 登记项。
  真实 spawn 生产入口、真实 HTTP、真实 home-node-client、真实 authority、
  真实失败分类；**零 mock store**。
- `tests/test_p11_3g_delivery_mutations.js` —— **14 / 14 CAUGHT**，baseline GREEN，
  原仓库 **SHA-256 逐字节零漂移**（变异全在 `%TEMP%\ib-3g-mut-*` 私有副本树内）。

### 测试盲区（下一次复审应当先看这里）

1. **「重启」是进程内的实例替换**，不是真的杀掉浏览器进程再重来 —— boot hydrate 的
   掩盖效应因此是**推出来的**（H7），不是在真实浏览器里量出来的；
2. `retention` 的**触发阈值**在专项里用注入接缝调小（`changeLogMax`），生产值是 20000 ——
   真实规模下的回收耗时没有实测；
3. **空档判据在当前生产路径上不可达**（L 节已如实标注）—— 它没有在真实故障中被观察到过；
4. 多 consumer 只用**第二个 consumer id** 模拟过，没有第二台真实设备；
5. `active/http.js GET /events` 的同形状窗口**没有做端到端取证**（只核对了代码形状）。

### discovered but NOT fixed

- **`active/http.js` 的 `GET /events`：同形状的第二处窗口。** 按 `!event.acknowledged`
  过滤、按 `sent_at` 升序、`limit` 上限 **100**；那里**没有** attempts 计数、**没有**终态、
  **没有**回收 —— 于是一个永不被 ack 的事件会永久占据一个槽位。它属于
  **companion / proactive 事件面**（不是 change-log 投递），有自己的 ack 端点与移动端契约，
  按阶段边界**只登记不修**。
- **P11-3F 登记的三项债务一条未动**（本节刻意保留，防止被 3G 的文档更新覆盖）：
  ① `migrate()` 与 boot 首个 hydrate **未定序** → 未迁移的浏览器遗留动态会在
  authoritative-empty hydrate 时被清掉（R1/R2 用真实链路断言它**仍然存在**）；
  ② **memory / understanding / chat 各自持有独立的 hydrate 实现**（`page.records || []`
  同款兜底仍在，memory 已经知道 `truncated` 却只拿它记 `hasFullHistory`）—— 它们与 moments
  **不共用**投递原语，因此"不修就无法保证本阶段不变量"不成立（R3/R4）；
  ③ `moments.js` 仍有**两处裸 `db.transaction(...,'readonly')`** 绕过权威适配层（只读、
  非破坏），直写仍由 `moments-write-closed` / `moments-delete-closed` 守卫拦截（R5/R6）。
- `/status` 在 chat store 关闭时回答 500 · memory/understanding 的 store-closed→400 ·
  `createHttp` 的 `DEFAULT_STORES` 回退 · `Origin:null`/token 架构 —— 沿用 P11-3E 登记。
- `test_moments_browser_authority.js` 每次运行泄漏一个 `--user-data-dir`（`ibmom-br-*`，
  用 `proc.unref()` 且从不清理）：**既有**测试资源卫生缺陷，本阶段清掉了泄漏物但没改那个文件。
- `test_memory_consolidation.js` 的既有红灯（模型输出抖动）：未碰。

------

## P11-3H ⏳ Installer Lifecycle Convergence

**新增阶段。** 原因来自 P11-3B 已确认的真实缺口。

### 缺口事实

`runtime/component-registry.js` 已经成为**运行期 component SSOT**，
但：

```text
installer/tools/ib-stop.js
```

仍然维护**自己那份旧的 serviceTable**，其中**没有 Home Node**。

实测该表当前只有 4 项：

```text
web       23120
runner    23116
bridge    23115
active    23114
```

—— `homeNode` (23118 / `internal-beyond-home-node`) **缺席**。

### 由此可能产生的后果

- Home Node 在升级/卸载时**没有 graceful stop**
- runtime 的 `node.exe` 仍被映射/占用
- Inno 的 `--wait-unlock` 等待超时
- **installer lifecycle 与 runtime lifecycle 漂移**
  （registry 说有几个组件，installer 说有几个组件）

### 阶段目标

- installer stop lifecycle **能识别 Home Node**
- **不在 installer 中重新维护一套容易漂移的 component truth**
- 处理 Inno `{tmp}` 提取环境 —— **不能简单假设**
  `require('../runtime/component-registry.js')` 可用
- Home Node graceful shutdown
- runtime unlock
- upgrade / uninstall correctness
- **installer / release-manifest / updater lifecycle 对账**
- 对"缺 Home Node"的旧行为建立 **regression test**

> ⚠️ 本阶段尚未开始。以上为目标定义。

------

## P11-3 期间发现的其他独立缺陷（低优先，不与 3E 混提）

- **D. UI 暴露内部错误码**：`assets/js/moments.js:2152`/`:2168` 把 `error` 原文弹给
  用户。按 P6 契约，所有 `*-write-closed` / `*-delete-closed` 这类 code 都应映射成
  普通用户文案，技术细节只进折叠区。（与 3E 同源，可一并做）
- **E. 文本去重契约分裂**：`active/moments.js` 的 reply 走 `text_key` 并按**语义
  相似度**去重，而 create 走逐字 `content_key`（`assets/js/moments.js:722+`）。
  同一套去重契约两个域两条规则,正文几乎相同的两条动态可以绕过。
- **F. `reply_comment_log` 会被 PUT 快照抹掉**（⚠️ **未经独立复核，仅供参考**）：
  `active/moments.js:993` 写、`:623-625` 读，经 `active/http.js:430-448` →
  `sanitizeMomentSchedule` 重建对象时丢字段。后果是 companion 评论冷却只靠线程内
  时间戳。若属实，属典型"字段没进 sanitize 白名单"。
- **G. 开发期静态服务以仓库根为 docroot**：`services/internal-beyond-server.js:108-117`
  靠 deny 段表挡 `logs/tests/vision/scripts`；安装版是同一份代码服务一棵
  "那些文件根本不存在"的树。这是产品里最接近"开发 / 安装行为分歧"的不对称。
- **H. README 第 140 行反例**：称 `.cmd` / `.vbs` / 直接打开 HTML 都不随包分发 ——
  `.cmd` 与 file:// 那半句为真，但 `启动 InternalBeyond.vbs` **恰恰随包分发**
  （`scripts/release-manifest.js:69`）且就是快捷方式的目标
  （`installer/InternalBeyond.iss:113-125`）。可信读法：「开发期 `.cmd` 入口与
  file:// 用法不属于安装版产品」。
  manifest 实测：36 条目 / 275 文件 / 119.5 MiB，`missing=[]`、`denied=[]`。

------

## 测试纪律推论（P11-3C 教训，后续通用）

**多实例进程级夹具的身份必须来自每进程独有的事实（路径 / 参数），不能来自共享环境变量。**

一个进程组的多个实例共享同一份环境变量。P11-3C 的假服务夹具
（`tests/fixtures/p11-3c-fake-service.js`）最初用共享的 `IB_P113C_COMPONENT`
选身份，结果三个实例里有两个绑到别人的端口、返回别人的健康身份，测试全线误判为
"恢复没触发"。正解：夹具用自身文件名（`argv[1]` 的 basename）作身份，runner 为每个
组件各放一份 `fakes/<componentId>.js` 副本。

推论：配置查找顺序一旦有歧义，测的就是夹具自己。

------

# II. P11 最终收口

## P11-2H ✅ `6dbd55e`

### Group Prompt Input Boundary

解决 P11-2F 留下的问题：

```text
groupName
participantName
nickname
relationship metadata
```

进入 prompt 前的边界。

处理：

- newline injection
- CR/LF
- control characters
- delimiter injection
- abnormal Unicode
- empty metadata
- 超长 metadata

建立 canonical metadata sanitizer。

**已做到的关键点**：用户元数据不再能变成 prompt 结构
（commit subject：*stop user metadata from becoming prompt structure*）。

**禁止顺便重构 Group Runtime。**（未被违反）

------

## P11-2I ✅ `a45102a`

### Integrity Closure Audit

这是 P11 的最终验收。

检查所有入口：

```text
                 IB Interaction
                       │
      ┌────────────────┼────────────────┐
      │                │                │
     Chat            Group           Moments
      │                │                │
    Diary           Letters          Mobile
      │                │                │
      └────────────────┼────────────────┘
                       ↓
                Identity Boundary
                       ↓
                 Memory Boundary
                       ↓
               Side Effect Boundary
                       ↓
                  Observability
```

确认不存在：

- 绕过 Integrity 的路径
- 绕过 Memory Visibility 的路径
- 绕过 Side Effect Gate 的路径
- 第二套 visibility 规则
- 第二套 persona 判断
- silent fail-open

### 审计结论（据 commit `a45102a`）

关闭了**两条在每个界面上都不可见的副作用路径**
（commit subject：*close the two side-effect paths that were invisible on every surface*）。

即：本次审计的核心产出不是"确认没有任何绕过"，而是**确实找到了两条默默生效的
副作用路径并把它们变成了可执行边界**。

------

## P11-2J ✅ `78f0193`

### Memory Admission Audit

**这是一次 audit，不是修复。** 它产出的是一张"真实写入入口地图"，
不是一组已关闭的缺陷。下列条目中标注为**缺口**的，仍是**未修复**的开放项。

#### 已建立：Memory Write Entry Registry

把长期记忆库的**每一个写入入口**连同它**实际适用的 admission 规则**登记成册
（commit subject：*map every long-term memory write entry and its real admission rule*）。

意义：在此之前，"某条记忆是怎么进来的"只能靠读代码猜；之后它是一张可对照的表。

#### 三条不同的轴（核心结论）

```text
Admission   —— 这条记忆**该不该被写入**（资格）
Consent     —— 用户**是否同意**被这样理解
Visibility  —— 谁**可以读到**它
```

**这是三条彼此独立的轴，不能互相代替。**

- 一条记忆可以 admission 合法但 visibility 受限；
- 也可以 visibility 公开但 consent 从未取得；
- **不存在"visibility 通过 ⇒ admission 通过"这种推论。**

这条区分直接约束了后续所有 memory 相关改动：**禁止把三者折叠成一个"可见性判断"。**

#### 具体的 admission 判定

- **用户明确保存 → 属于合法 admission exemption**
  （用户直接说"记住这个"是一条豁免通道，不需要再过推断侧的 admission 门）。
- **AI 推断 → 必须走 calibration + consent**
  （模型自己推断出来的长期记忆不能凭推断直接入库，需经过校准与同意）。

#### 已确认的两处缺口（**未修复**）

1. **diary admission 是已确认的历史缺口。**
   日记路径的写入在 admission 语义上存在历史遗留的不一致。
2. **consolidation 丢弃 calibration `.rejected` 是已确认的缺口。**
   记忆合并过程会把 calibration 阶段标记为 `.rejected` 的条目丢掉，
   而不是让它们按既定规则参与。

> ⚠️ 以上两条是**已确认缺口**，不是"已修复项"。本阶段只负责**确认并登记**。

#### 边界声明

**storage layer 不负责 admission policy。**

存储层只负责存与取；"该不该存"是策略层的职责。
**禁止**把 admission 判断下沉到 storage layer（那会制造第二套策略真理源，
并使 entry registry 重新失效）。

### P11 完成条件

做到这里：

> **Middle Brain / Integrity Foundation 正式冻结。**

------

## AI Regression / Resource Discipline ✅ `158367f`

`docs/INTERNALBEYOND_AI_RULES.md` 已加入并冻结以下纪律（**全文不在此复制**）：

- **baseline / candidate 全量 sweep 禁止并行**（并行会让资源争用污染对照）
- **heavy / browser / runtime 并发上限 = 1**
- **sweep 之间必须清理测试子进程**（不得留下 server / child / timer / socket）
- **zero-production-change 例外**：确实零生产改动时，允许只跑专项 regression，
  不必强制全量
- **failure 必须分类**：不得把**资源耗尽**直接算作产品回归

该文件是回归执行纪律的**唯一事实源**，Q 轨道（见下）直接继承它，不另立一套。

------

# II-b. P11 最终收口：P11-3 FREEZE 门

------

# III. P12 · Home Node / Mobile Contract Convergence

这是正式大规模开发 Android 功能之前的最后一层地基。

## P12-1 · Mobile Contract Inventory

冻结 Android 真正可以访问的：

```text
/mobile/v1/*
```

整理：

- auth
- device
- character
- chat
- history
- sync
- presence
- media
- notification
- social

禁止继续靠“猜某个 Desktop API Android 也能调用”。

------

## P12-2 · Authority Boundary

明确：

```text
Android
   ↓
Home Node
   ↓
Canonical Runtime
```

谁负责：

- 消息 ID
- 时间
- revision
- character state
- memory state
- sync cursor
- conflict resolution

------

## P12-3 · Sync Contract

统一：

- hydrate
- incremental changes
- reconnect
- retry
- idempotency
- revoke
- tombstone
- cursor
- degraded mode

------

## P12-4 · Mobile Contract Closure

完整测试：

```text
Android ↔ Home Node
```

契约冻结后：

> Android UI 可以高速迭代，不再跟着 Runtime 内部结构变化。

------

# IV. M2 · Android Design System

从这里开始进入真正的“安卓版 IB”。

## 四个设计来源

### ① Sui-IB/InternalBeyond-Mobile

用途：

**IB Mobile 功能语义参考**

借：

- 原作者 Mobile 思路
- 页面信息架构
- Native Bridge 思路
- IB 功能如何映射到 Mobile

不照搬：

- Web/Capacitor 技术结构

------

### ② RikkaHub

用途：

**Android 原生 UX 参考**

重点参考：

- Chat UX
- 输入框
- 模型选择
- Settings
- Bottom Sheet
- Attachment
- Android navigation
- edge-to-edge
- 原生手势

不照搬视觉品牌。

------

### ③ 视觉参考 A

发的白色页面。

作为：

## IB Companion Home

视觉特征：

- 大面积留白
- 漂浮照片
- 轻微旋转
- 大圆角
- 柔和阴影
- 角色头像
- 功能岛
- 信笺
- 对话碎片
- 胶囊 Bottom Navigation

重点：

> **不像 AI 工具，更像角色生活空间。**

------

### ④ 视觉参考 B

深蓝角色卡。

作为：

## Character / Agent Card System

视觉特征：

- Hero Image
- Avatar overlap
- 大圆角
- 半透明信息层
- Character Name
- Provider
- Model
- Status / Quote
- 深色沉浸背景

可以用于：

- Character Library
- Group Member
- Agent
- API Binding
- Character Switcher

------

## M2-1 · Design Tokens

冻结：

- radius
- spacing
- typography
- elevation
- blur
- opacity
- card ratio
- avatar size
- animation duration
- haptic semantics

------

## M2-2 · Navigation

确定：

- Home
- Chat
- Character
- Social
- Memory
- Settings

以及：

- Bottom Navigation
- Bottom Sheet
- FAB
- Full Screen
- Back Gesture

------

## M2-3 · Theme

完成：

- Light
- Dark
- Character Accent
- wallpaper
- blur
- system bar integration

------

# V. M3 · Android Chat Experience

## M3-1 · Single Chat

优化：

- Streaming
- Markdown
- Code
- Image
- File
- Reply
- Quote
- Regenerate
- Edit
- Copy
- Selection

------

## M3-2 · Input Composer

实现成熟 Mobile Composer：

```text
＋  [输入消息................]  🎙  ↑
```

支持：

- image
- camera
- file
- voice
- skill
- edit image

------

## M3-3 · Group Chat

等 Home Node contract 成熟后接入真正 Group。

支持：

- group avatar
- participant
- temporary mute
- 中途加入成员
- role switch
- multi-character response

但：

> **Android 不自己实现 Group Runtime。**

------

## M3-4 · Character Switch

采用视觉参考 B：

```text
Hero
Avatar
Character
Provider · Model
Status
```

做快速角色切换。

------

# VI. M4 · Android Native Capability

## M4-1 · Camera / Gallery

```text
Camera
  ↓
Android
  ↓
Home Node
  ↓
Vision Model
```

支持：

- 拍照
- 相册
- 图片压缩
- EXIF
- 上传
- Vision

------

## M4-2 · Voice

接 Desktop IB 已有：

- ASR
- TTS
- barge-in
- character voice

Android 增加：

- Microphone
- Audio Focus
- Bluetooth
- Speaker
- Earphone
- Background audio

------

## M4-3 · Notification

支持：

- Proactive Message
- Role Letter
- Moments
- Diary
- Skill result

------

## M4-4 · Background

处理：

- app background
- process death
- reconnect
- notification
- pending sync

------

## M4-5 · Android Native Integration

包括：

- Share Sheet
- Deep Link
- Clipboard
- File Picker
- Haptic
- Media Session
- Picture-in-Picture（需要时）

------

# VII. M5 · Companion / Social

这是 Android 真正开始体现 IB 与普通 AI Chat App 区别的阶段。

## M5-1 · Moments

移动端：

- Feed
- AI post
- AI↔AI
- comments
- likes
- pagination
- notification

------

## M5-2 · Role Letters

移动端信箱：

```text
角色
 ↓
一封信
 ↓
Notification
 ↓
Letter UI
```

支持：

- unread
- readAt
- owner filtering
- roleLetterMemories

------

## M5-3 · Diary

支持：

- 每周日记
- AI 随机写日记
- 密码日记本
- 日记阅读
- 时间线

------

## M5-4 · 收藏墙

把 Desktop 收藏墙移动化。

------

## M5-5 · Co-read

手机共同阅读体验。

------

## M5-6 · Cinema

移动端共同观看 / Cinema Experience。

------

# VIII. M6 · Character / Memory / Settings

## M6-1 · Character Library

视觉参考 B 在这里完整落地。

------

## M6-2 · Character Detail

展示：

- persona
- relationship
- voice
- model
- status
- memories
- moments
- letters

------

## M6-3 · Memory Experience

注意：

Android 不直接管理 canonical DB。

结构：

```text
Android Memory UI
        ↓
Home Node Memory API
        ↓
Memory Visibility Core
        ↓
Canonical Memory
```

支持：

- 查看
- 搜索
- 删除
- visibility
- memory source
- consolidation status

------

## M6-4 · Middle Brain Mobile Controls

Android 可以修改：

- Enabled
- Model
- Reasoning
- Speed
- Image Mode
- Integrity

但是配置写回 Home Node/Desktop authority。

------

## M6-5 · Provider Settings

手机允许：

- 查看 Provider
- 查看 Model
- 修改绑定
- 查看状态

默认不把 Provider Secret 下发 Android。

------

# IX. M7 · Reliability / Network / Multi-device

## M7-1 · Offline

实现：

```text
Online
 ↓
Local Mirror
 ↓
Offline Read
 ↓
Reconnect
 ↓
Incremental Sync
```

------

## M7-2 · Conflict Resolution

处理：

- 双端修改
- revision
- tombstone
- stale client
- replay

------

## M7-3 · Multi-device

支持：

- Android Phone
- Tablet
- Desktop

设备：

- register
- revoke
- last seen
- presence

------

## M7-4 · Remote Home Node

支持外网安全访问。

可研究：

- Tailscale
- Tunnel
- VPN

------

## M7-5 · Transport Security

正式收口：

```text
HTTPS
WSS
Device Token
Pairing
Revoke
```

------

# X. M8 · Visual Fidelity & Interaction Polish

这个阶段**不能因为功能能跑就跳过**。

目标就是把 App 做到你两张参考图那种完成度。

## M8-1 · Home Visual

重点实现视觉参考 A：

- floating cards
- rotated photography
- character space
- letter
- chat fragments
- soft shadow
- large whitespace

------

## M8-2 · Character Card

重点实现视觉参考 B：

- Hero Image
- avatar overlap
- glass info panel
- character/model metadata
- animated cards

------

## M8-3 · Motion

统一：

- page transition
- shared element
- card expand
- message arrival
- streaming
- avatar transition
- bottom sheet

------

## M8-4 · Physical Feel

加入：

- Haptic
- overscroll
- spring
- gesture
- swipe
- long press

------

## M8-5 · Android Polish

处理：

- Edge-to-edge
- Status Bar
- Navigation Bar
- IME animation
- keyboard
- foldable
- tablet
- orientation
- accessibility

------

# XI. N · Tauri 2 Track

这是一条**并行路线**，不要阻塞 Native Android。

## N1 · Tauri 2 Feasibility

研究：

```text
IB Web Frontend
       ↓
    Tauri 2
       ↓
Windows / macOS / Linux
```

以及 Android/iOS 是否值得共享部分能力。

------

## N2 · Desktop Shell

替换/补充现有启动方式：

- native window
- tray
- notification
- deep link
- protocol handler

------

## N3 · Native Bridge

接：

- filesystem
- secure storage
- notification
- clipboard
- media
- OS integration

------

## N4 · Update / Distribution

支持：

- auto update
- installer
- release channel
- version migration

### 原则

**不要为了 Tauri 2 把 Native Android 重新 WebView 化。**

------

## N0 · Tauri 2 前置优化（现在就该做，刻意不做「大重构」）

Tauri 2 不是"换一层壳"就完事：它改变的是**页面从哪个 Origin 运行**、**桌面桥走什么传输**、
**子进程由谁拉起**。下列各项的共同特点是——**现在改成本极低，等 Tauri 落地时改就是
穿透式重构**。全部刻意不做大重构，只做"加一层/收一处"。

### ⚠️ 冲突项：必须与 Zero-Setup 发行决策对账

既有 Zero-Setup 发行决策明确写了：

> **不引入 Electron/Tauri/WebView2，用系统默认浏览器。**

本节的 Tauri 2 是**后续并行轨道**，与该决策冲突。N1 立项时必须显式改掉那条决策
（或写明适用范围），**不允许两处并存而不对账**——否则 P2/P5/P7 的启动链、
诊断、安装器纪律会各自按不同前提演进。

### N0-1 · Origin 单一事实源 🔴 最高优先

**风险**：Tauri 2 的 WebView origin 与 `http://127.0.0.1:23120` 不同。实测资料显示
Windows 上 Tauri 使用 `http://tauri.localhost`（真 `http` scheme，因此**不是**
`Origin: null`），macOS/Linux 为 `tauri://localhost` 形式。

**现状**：两处 Origin 白名单都写死了具体形态，都**不覆盖** Tauri：

| 位置 | 现有白名单 | Tauri 结果 |
| --- | --- | --- |
| `services/home-node/http.js:121-128` | `null`（仅无 token 时）/ `http(s)://127.0.0.1\|localhost\|[::1]` | ❌ 拒绝 |
| `services/home-node/mobile-gateway.js:374-382` | `null` / `capacitor://` `ionic://` / `http(s)://localhost` | ❌ 拒绝（`tauri.localhost` 能匹配 :380 的 regex，但 `tauri://` 不能） |

注意 `mobile-gateway.js:370` 的注释**已经预留了 Capacitor**——说明这个位置本来就是
留给"未来换壳"的。Tauri 只是漏了同一个位置。

**改法**：在 `runtime/component-registry.js` 里给每个组件增加 `origin` / `url` 字段
（registry 已有 `defaultPort` + `healthPath` + `identity`，**唯独没有 URL**），
让 Origin 白名单从 registry 派生，而不是各写各的正则。附带收益：`assets/js/*` 里
硬编码的 `http://127.0.0.1:23115` / `:23114` / `:23118` 也能一起收口。

### N0-2 · 组件 URL 收口 🟡

`assets/js` 里环回地址是散落的字面量：

```text
communication.js:134        http://127.0.0.1:23115
bridge.js:11                http://127.0.0.1:23115
active-diary.js:6           http://127.0.0.1:23114
home-node-client.js:20      http://127.0.0.1:23118
```

已有先例可循：`assets/js/diagnostics.js` 的纪律是"端口唯一来源是 boot-state"
（`tests/test_diagnostics.js:77` 已在强制该约束）。把同一条纪律推广到所有组件 URL。

### N0-3 · localStorage 关键状态要能迁走 🟠 比想象中容易被忽略

**IndexedDB 会随 WebView 数据目录存活，但 Tauri 换壳等于换 Origin —— 而
localStorage 是 per-Origin 的。** 不做迁移方案，用户会看到"角色、日记、互动记录都在，
但设置全没了"——比全新安装更糟，因为半新半旧。

`localStorage.setItem` 在 `assets/js` 有 **55 处命中**，其中是真实用户状态的包括：

```text
ib_active_user_id            active-diary.js:47    ← 用户身份，换 Origin 会换出一个新 user id
MOMENT_STATE_KEY / _PREFS_KEY / _COMMENT_LOG   moments.js:183/190/245
RL_STATE_KEY / _PREFS_KEY / _PAIR_KEY          role-letters.js:65/71/74
ACTIVE_AI_PREFS_KEY / ACTIVE_INTERACTIONS_KEY  active-plans.js:41/647
DIARY_PREFS_KEY / ib_diary_watermarks_v1       diary.js:24/30
ib_workspace_win / ib_wsRunMode                 workspace.js:1248
```

**改法**：已有现成抽象（`assets/js/local-first.js` 的 `localSet`、
`assets/js/app-store.js` 的 `_save`、`core.js:1026` 的 `IB_MIRROR_KEY` 备份），
把"关键状态"按契约只走这几个口子，并补一条"可导出/可导入"路径。
**禁止**再新增散落的 `localStorage.setItem`。

### N0-4 · `process.execPath` 启动链与 P2 纪律的冲突 🟡 必须在 N1 时对账

P2 明确**不得重构** `local-services-runner.js` 的 `process.execPath` 启动机制，
且 `tests/test_node_runtime.js:209-219` 把这个决定**锁成了测试断言**
（`SERVICES[].command must remain process.execPath` / `launcher must keep spawning with process.execPath`）。

Tauri 侧的对应机制是 `externalBin` sidecar。**好消息**：sidecar 同样让
`process.execPath` 指向自身，所以这条链大概率能原样工作。但这属于"应当验证的假设"，
不是"已知成立"。N1 立项时要**显式对账** P2 纪律与该测试断言，
**不要在 N0 阶段就动它**——那会同时违反 P2 纪律和既有测试。

### N0-5 · 桥的传输抽象 🟡

若 Tauri 走 IPC（`invoke`）而非 HTTP，则 `ib-bridge-core` 这类"把传输细节藏起来
只暴露能力"的抽象会被放大利用；反之，散落的 `fetch('http://...')` 会成为迁移成本。
方向：**让能力按名字调用，而不是按 URL**。

### N0-6 · 诊断/组件真相源已经领先 ✅ 无需改动

`runtime/component-registry.js`（P11-3B `bd9dc0d`）把 5 个组件的
id / 端口 / 身份探针 / 必需语义 / 状态映射集中到了一处，并且
`boot-state` 的 `COMPONENT_ORDER`、launcher 组件轴、runner 服务表、重启目标
全部从它派生。**这是对 Tauri 最有利的一项既有资产**——Tauri 换壳时
"有哪些组件、各自在哪、怎么认身份"不需要重新发现。N0-1 只是把它再往前推一格。

### N0-7 · 打包/发行/更新需要另起一套 🟡

`installer/InternalBeyond.iss`（Inno，per-user 免 UAC）、`scripts/release-manifest.js`
（36 条目 / 275 文件 / 119.5 MiB）、`runtime/update-install.js` 是当前发行链。
Tauri 有自己的 bundle 格式与 updater（且 updater 需要签名密钥——而
Zero-Setup 决策里"首版不做代码签名"意味着**更新器不能直接启用**，
需要与签名决策一并重新决定）。

### N0-8 · Kiosk / 单窗口假设 🟢 低优先

现有前端假设"一个已知 Origin 下的单页"。Tauri 支持多窗口，多窗口会把
`home-node-bootstrap.js` 的单例假设（`MODE`/`FILE_ORIGIN` 在加载时固化一次、
`momentsSyncInFlight` 单飞等）暴露出来。目前不需要动，但**不要在 Tauri 侧
顺手开多窗口**，除非先处理这些单例。

### N0-9 · CSP / `connect-src` / 自定义协议 🟢 低优先

页面会从 `http://127.0.0.1:23114/23115/23118` 取数据。Tauri 的 CSP 若收紧，
需要把这些来源列入 `connect-src`。当前实现无 CSP 概念，属于新增工作。

### N0-10 · 环境变量注入载体 🟢 低优先

launcher 通过 env 传端口（`IB_WEB_PORT` / `IB_RESTART_PORT` / `IB_BRIDGE_PORT` /
`IB_ACTIVE_PORT` / `IB_HOME_NODE_*`）。Tauri 拉起 sidecar 时 env 注入方式不同，
需要确认这条通路仍在。（**相关教训**：见下方"测试纪律推论"——多实例身份不能
来自共享环境变量。）

### N0 建议顺序

```text
N0-1  Origin 单一事实源        ← 现在做，收益最大、风险最低
N0-2  组件 URL 收口            ← 与 N0-1 同一笔改动
N0-3  localStorage 关键状态收口 ← 独立，随时可做
N0-4  P2 纪律对账              ← N1 立项时做，禁止提前动
N0-6  已有资产 ✅ 不动
其余  等 N1 可行性结论
```

------

# XII. S · IB Skills / Agent Capability

这是另一条重要并行路线。

目标：

> 角色不仅能聊天，还能替用户做事情。

------

## S1 · Skill Contract

定义：

```text
Skill
├─ id
├─ capability
├─ input schema
├─ permission
├─ execution environment
├─ result schema
└─ side effects
```

------

## S2 · Skill Router

结构：

```text
Character
    ↓
Middle Brain
    ↓
Skill Router
    ↓
Permission / Side Effect Gate
    ↓
Skill
```

Skills **不能绕过 Middle Brain Side Effect Boundary**。

------

## S3 · Browser / Playwright Skill

让 AI 可以：

- 浏览网页
- 搜索
- 点击
- 读取
- 比较
- 提取结构化数据

运行位置：

**Home Node / PC**

而不是 Android。

------

# XIII. S4 · 淘宝 Shopping Skill

你之前提出的“AI 逛淘宝”正式放这里。

例如：

> 帮我找 7000 元以内的 RTX 5070 Ti，三风扇。

执行：

```text
User
 ↓
Character
 ↓
Middle Brain
 ↓
Shopping Skill
 ↓
Browser / Playwright
 ↓
Taobao
 ↓
Candidates
 ↓
Ranking
 ↓
IB Result
```

------

## S4-1 · Search

支持：

- keyword
- price
- brand
- spec
- seller

------

## S4-2 · Compare

生成结构化：

```text
商品
价格
店铺
规格
销量
评价
风险
```

------

## S4-3 · Shopping Safety

区分：

```text
搜索        可自动
比较        可自动
收藏        可配置
加入购物车  需权限
下单        强确认
付款        不自动
```

------

# XIV. S5 · Android Skill UI

Android 展示：

```text
角色正在帮你找……
        ↓
Skill Progress
        ↓
商品卡片
        ↓
比较
        ↓
角色建议
```

这样 Skills 不会退化成一堆工具调用日志。

------

# XV. S6 · Skills Expansion

后续可以扩：

```text
IB Skills
│
├── Shopping
│   └── Taobao
│
├── Browser
├── Search
├── Weather
├── Calendar
├── Files
├── Music
├── Maps
├── Smart Home
└── Device
```

------

# XVI. Channel Track

Skills 稳定后再继续外部渠道。

包括：

## C1 · QQ

之前规划：

```text
NapCatQQ
   ↓
OneBot 11
   ↓
IB Channel
   ↓
Character Runtime
```

------

## C2+

后续：

- Telegram
- Discord
- 其他 IM

统一走 Channel Adapter，不给每个平台复制一套 Character Runtime。

------

# XVII. Q · Quality / Release Gate

**这是一条横向验证轨道，不是另一套 Runtime。**
它横跨所有主功能阶段，回答的是"什么叫做完了"，而不是"要做什么功能"。

## 继承的纪律（唯一事实源）

本轨道**直接继承** `docs/INTERNALBEYOND_AI_RULES.md` 中的 regression execution
constraint（见前文「AI Regression / Resource Discipline ✅ `158367f`」），
**不另立一套测试纪律、不复制正文**。

关键约束摘要（详见该文件）：

- baseline / candidate 全量 sweep **禁止并行**
- heavy / browser / runtime 并发上限 = **1**
- sweep 之间**必须清理**测试子进程
- zero-production-change 允许只跑**专项** regression
- failure **必须分类**，资源耗尽不得直接算作产品回归

## Q1 · Runtime Regression

Desktop / Home Node 运行期回归。

覆盖：canonical 域写入与读取、authority 三态（authority / mirror / fallback）、
组件健康与恢复（P11-3B/3C）、diagnostics 与 boot-state 一致性。

**特别需要补的**：`http` 承载 × authoritative 的**生产态**覆盖
（当前是 P11-3E 记录的最大测试盲区）。

## Q2 · Mobile Contract Regression

`/mobile/v1/*` 契约回归：auth / device / character / chat / history / sync /
presence / media / notification / social。

与 **P12 Mobile Contract Convergence** 互为闭环：P12 冻结契约，Q2 守住它。

## Q3 · Android UI / Native Regression

Android 侧 UI 与原生能力的回归（对应 M2–M8）。

## Q4 · Packaging / Installer

安装包构建、per-user 安装、快捷方式、内置 runtime、release manifest、
以及 **P11-3H 的 installer lifecycle 对账**。

## Q5 · Migration / Upgrade

升级路径、数据迁移、镜像与 hydration 安全（含 **P11-3F**）、
卸载正确性与 runtime unlock。

## Q6 · Release Candidate Gate

RC 放行门：把 Q1–Q5 的结论汇总成"能不能发"的单一判定。

**禁止**把 Q6 做成"全绿就发"的机械门 —— 必须显式列出未修但已接受的风险。

------

# 最终路线总览

保存这一张基本就够：

```text
CURRENT
│
├─ P11-2 Foundation
│  ├─ 2A~2D ✅ Middle Brain / Integrity 基础
│  ├─ 2E ✅ Mobile / Group 生产接线（确认 Android Group Runtime 不存在）
│  ├─ 2F ✅ 582fb01 Desktop Group Memory Policy
│  ├─ 2G ✅ 8058184 Memory Visibility Core
│  ├─ 2H ✅ 6dbd55e Group Prompt Input Boundary
│  ├─ 2I ✅ a45102a Integrity Closure Audit
│  └─ 2J ✅ 78f0193 Memory Admission Audit
│
├─ AI Regression Discipline ✅ 158367f
│   docs/INTERNALBEYOND_AI_RULES.md（回归执行 / 清理 / 失败分类）
│
├─ P11-3 Desktop Runtime Hardening
│  ├─ 组件事实源 ✅ bd9dc0d Component Registry
│  ├─ 3A ✅ 3ebb66e Credential Boundary
│  ├─ 3B ✅ bd9dc0d Component Registry + Health Aggregation
│  ├─ cleanup ✅ 9a19558 launcher 端口解析器移除
│  ├─ 3C ✅ f6b9a59 Supervisor（有界崩溃恢复）
│  ├─ 3D ✅ b1af1db Tool Execution Guard
│  ├─ 3D.1 ✅ 574193a Host-turn Tool Budget Convergence
│  │      ONE HOST AI TURN = ONE TOOL EXECUTION CYCLE = ONE TOTAL BUDGET
│  ├─ 3X-A ✅ 5ab085e Security / HTTP Boundary
│  │      named foreign Origin / Bridge /status token 线 / viewer 缺省 vs 空值
│  │      已接受 Origin:null（D1）；SEC-D1 / SEC-D2 债务记录不改
│  ├─ 3X-B ✅ 67c59be Runtime / DB Reliability
│  │      health truthfulness / 隔离闸门只由完整性结论授权 / db-* 分类
│  │      端口归属预检（绝不 kill 外部占用者）/ 重复 runner 明确失败
│  │      根因传播进终态（db-readonly，而不是 process-exit）
│  ├─ 3X-C ✅ 1a64705 Performance / Context Budget
│  │      canonical IBContextBudgetCore（唯一估算器 + 应用级天花板 + 三档预算）
│  │      ONE HOST AI TURN → ONE CONTEXT BUDGET（工具定义/persona/当前消息永不裁）
│  │      turn-scoped reads：favorites 单飞 · 线索存证 1 次 · posts 1 次 · dbUpdate
│  │      引导轮询有界（basement 400ms / game_room 500ms → 3s 退避）
│  ├─ 3E ✅ 2d184c6 Moments Canonical Closure
│  │      ONE MOMENTS AUTHORITY = Home Node canonical moments store
│  │      openAll()/shutdown() 开闭闭环（唯一打开入口 openMomentStore）
│  │      store-closed → 503 / 终态 db-* → 500 / 请求问题 → 400·422（可区分）
│  │      health 覆盖全部 canonical store（serving + stores[]），不假绿
│  │      重启 ×3 持久化 + 墓碑 + change_log + 设备面无 verb（实测）
│  │      103 项专项 + 11/11 mutation CAUGHT（私有副本树，原树零漂移）
│  ├─ 3F ✅ bb3785d Hydration / Mirror Safety
│  │      ONE CANONICAL REMOTE STATE → ONE LOCAL MIRROR
│  │      破坏性替换的授权判据：ok + records 是数组 + truncated===false + revision 是数字
│  │      unavailable / invalid / incomplete **不碰镜像**；authoritative empty **必须**能清空
│  │      串行镜像锁 + hydrateGen 代次 + mirrorRevision 水位（旧快照不得回退镜像）
│  │      原子替换：clear+put 同一 IndexedDB 事务 + 同步抛错显式 abort（真实 Chrome）
│  │      /moments/list 如实声明 truncated；行集与 revision 出自同一读事务
│  │      120 项专项 + 11/11 mutation CAUGHT（私有副本树，原树零漂移）
│  ├─ 3G ✅ 327dbfb Change-Log Delivery Closure
│  │      ONE CHANGE EVENT → BOUNDED DELIVERY → EXPLICIT OUTCOME → NO HOL BLOCKING
│  │      ACK(W) = consumer 对 revision ≤ W 的每个 event 都已得出**持久结论**
│  │      （不证明 HTTP 200 / 读过 / 尝试过）；服务端只拿它决定日志回收边界
│  │      四状态不压成一个 boolean：PENDING / APPLIED / RETRYABLE / TERMINAL
│  │      有界 attempts + 非零退避 + 持久化（浏览器 meta 平面，不新建表/不升 schema）
│  │      终态 → cursor 越过 → 本页继续 → **快照**把它补回来（3F hydrate 契约未改）
│  │      回收只在「全体已注册水位的最小值」以下；没有水位一行都不删（fail-safe）
│  │      /moments/changes 报 retainedFrom；缺它即拒收（回收空档 ≠ 日志里没有）
│  │      127 项专项 + 14/14 mutation CAUGHT（私有副本树，原树零漂移）
│  └─ 3H ⏳ Installer Lifecycle
│
▼
P11-3 FREEZE
│
▼
P12 Mobile Contract Convergence
│
├──────────────────────────────┐
│                              │
▼                              ▼
ANDROID                        PARALLEL
│                              │
M2 Design System               ├─ N0 Tauri 2 前置优化
│  ├ Sui-IB/InternalBeyond-Mobile │   ├ Origin 单一事实源 🔴
│  ├ RikkaHub                    │   ├ 组件 URL 收口
│  └ 两张视觉参考 A / B           │   └ localStorage 状态收口
│                                ├─ N1-N4 Tauri 2
▼                                │   ⚠️ 与 Zero-Setup 决策冲突，须先对账
M3 Chat Experience               │
│                                └─ S1-S6 Skills
▼                                    ├ Browser / Playwright
M4 Native Capability                 └ 淘宝 Shopping
│
├ Camera / Vision
├ Voice
├ Notification
├ Background
└ Android Integration
│
▼
M5 Companion / Social
│
├ Moments
├ Letters
├ Diary
├ 收藏墙
├ Co-read
└ Cinema
│
▼
M6 Character / Memory / Settings
│
▼
M7 Reliability / Network / Multi-device
│
▼
M8 Visual Fidelity
│
├ 视觉参考 A → Companion Home
└ 视觉参考 B → Character Cards
│
└──────────────┬───────────────┘
               ▼
          Channel Track
          ├ QQ / NapCat / OneBot
          ├ Telegram
          └ Discord
               │
               ▼
       Q Quality / RC Gate
       ├ Q1 Runtime Regression
       ├ Q2 Mobile Contract Regression
       ├ Q3 Android UI / Native Regression
       ├ Q4 Packaging / Installer
       ├ Q5 Migration / Upgrade
       └ Q6 Release Candidate Gate
               │
               ▼
            Release
```

## 最终产品定位

做完这条路线后，安卓版 IB 不应该是：

> **“InternalBeyond 的手机版聊天界面。”**

而应该是：

> **“InternalBeyond 的移动 Companion。”**

桌面/Home Node 负责**思考、记忆、执行与世界状态**；Android 负责**陪伴感、随身交互、原生设备能力和呈现**；Skills 负责**让角色真正做事**；Tauri 2 则负责把桌面端逐步收敛成更完整的原生应用壳。

这版可以作为后续阶段编号的 **Android/Mobile Master Roadmap**。