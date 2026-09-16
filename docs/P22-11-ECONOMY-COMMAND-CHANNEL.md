# P22-11 · Active → Home Node Economy Command Channel

> 状态：**已实现并验证**（阶段提交 `P22-11 · add authenticated Active Economy command channel`）
> 冻结基线：`7881e3a`（P22-10 · add Economy action adapter）
> 本文件是这个阶段唯一的权威叙述。P22-10 文档里"跨进程送一条动作这件事
> 本阶段不做"那句话，在本阶段被**有意**改写 —— 改写的形式是下面 §2。

---

## §1 §1 只读审计：这个仓库里已经有什么 transport

审计结论全部来自读代码，没有一条来自提示词假设。

### 1.1 已经有一份可复用的 transport，而且它就是既有事实

Home Node 的 HTTP seam（`services/home-node/http.js`）已经具备本阶段需要的**每一条**：

| 需要 | 既有实现 | 位置 |
|---|---|---|
| loopback 限制 | `isLoopback(req)`；非 loopback 来源由 `remoteAllowed()` 整片拒绝 | `http.js` |
| 桌面凭据 | `X-IB-Home-Token` / `Authorization: Bearer` / `?token=`，恒定时间比较 | `authorized()` |
| 请求信封 | `{ ok, protocolVersion, serverTime, … }` / 错误 `{ ok:false, error, … }` | `ok()` / `bad()` |
| requestId / 幂等 | `/messages`、`/memory/records`、`/moments/record` 早已在用 | 各路由 |
| 有界 body | `readBody(req, MAX_BODY_BYTES)` | `http.js` |
| 跨进程客户端 | `assets/js/home-node-client.js`（浏览器侧唯一的 Home Node 传输实现） | — |

⇒ **§1 的"能复用就复用、禁止新造第二套 transport framework"** 在这里的落点
是：本阶段**没有**新的服务器、没有新的协议、没有新的信封形状、没有新的
端口。新增的只有两样东西（§1.2 与 §2）。

### 1.2 缺的不是"能不能安全表达一条 command"，而是**来源绑定**

既有 transport 的凭据回答的是"你有没有这台机器的桌面凭据"。这个答案对
23114 与对**任何**本机进程是同一个 —— 因此它确定不了来源身份。
而 §3 逐字要求身份由 `authenticated transport + registered source/process/channel`
确定，**绝不由 payload 自报**。

这就是缺口，也是本阶段唯一新增的安全机制：

```text
每个来源有自己的 token（不与他人共用）
  → 只以 SHA-256 摘要进索引（token 本身不进索引、不进日志、不进 describe）
  → 恒定时间比较（先摘要再比，长度不同也不泄漏）
  → 每个来源登记在 P22-9 契约里**真实存在**的 consumer id 上
  → 每个来源登记一条**本机管道端口**（boundPort）
  → 登记册在装配期构造，运行期**不可改**（没有 setSource / addSource）
```

### 1.3 审计里另外三件事实（它们决定了本阶段的范围）

* **没有通用 Action dispatcher**（P22-10 已确认）。本阶段同样没有造。
* Active 的浏览器侧规划器（`assets/js/active-diary/active-plans.js`）是
  **浏览器 IIFE**（末行 `window.IB || (window.IB = {})`）：在 Node 里
  `require` 它直接抛 `ReferenceError`（开发期实测）。因此 companion 侧
  不能说"我用的是同一个文件"—— 它用的是一份**镜像是同款**的净化器（§5.3）。
* Active 的两条既有封闭动作集**一行都没有改**：
  * 浏览器侧 `['schedule','none','cancel_existing']` —— 原样保留为
    `_activeValidatePlanResultCore`；
  * Node 侧 `['send','reschedule','cancel']` —— `active/scheduler.js` 一个字没动。

---

## §2 唯一的一条跨进程 command

```text
ECONOMY_PROPOSE_PURCHASE          ← 唯一开放
```

`ECONOMY_BUY` / `ECONOMY_SETTLE` / `ECONOMY_RESERVE` / `ECONOMY_APPROVE` /
`ECONOMY_RESUME` / `ECONOMY_GRANT` / `ECONOMY_LEDGER` / `ECONOMY_WALLET_MUTATE`
**不是**"还没开放"：它们在这份词表里**不存在**（`COMMAND_LIST.length === 1`，载入期不变量断言这件事）。

★ **resume 本阶段不恢复**：`resume` 这个词在通道的**代码**里一次都不出现
（连"已知但不开放"的登记也不写 —— 那份 `NOT_OFFERED` 登记仍然只由
P22-10 的适配器持有，本阶段不复制、不改写）。测试里有一条对**剥注释后的
代码**做的扫描直接断言这件事。

路径：

```text
/internal/economy/command          ← 本阶段新增的**全部** HTTP 面就是这一条
```

★ 它刻意**不在** `/economy/` 前缀下。`/economy/*` 上的每一件事都是只读
（P22-2 起逐名断言），而这是一条**写**路径。把它放进 `/economy/` 会让
"POST /economy/* 一律 405 economy-is-read-only"这句话变成半真 —— 而这个
仓库刚在 P22-6/7/8/10 里四次修掉"声明与真实路由分叉"的同一类病。
`pathIsNotUnderEconomyReadPaths` 是 `/security` 上的一个可断言字段。

---

## §3 transport 不得相信 consumerId（本阶段最重要的不变量）

payload 里出现下面七个键里**任何一个**，请求当场被拒：

```text
consumerId · consumer · capability · role · authority · approved · autoAllow
```

* 拒绝码：`ECONOMY_COMMAND_NOT_ALLOWED_FOR_A_CONSUMER_TO_SELF_REPORT`（403）；
* `rejectedIdentityKeys` **逐名**点出是哪几个；
* `reachedActionAdapter: false` —— 这条路径**没有碰过**适配器；
* `sourceIdentityFromPayload: false`；
* 拒绝发生在 body 解析**之后**、任何经济判定**之前**。

调用方**没有**选择 consumer 的能力：通道的 `dispatch()` 根本没有接收
consumer 的参数，而它用的是装配期就绑好的那**一个**适配器
（`active_agent_runtime`）。

### 3.1 身份的两半，以及它们各自的分量（不夸大）

```text
来源身份 = 来源凭据（每个来源自己的 token，SHA-256 摘要 + 恒定时间比较）
         + 本机管道（登记端口；请求真的从那条端口发出才算）
         + loopback（非 loopback 在既有规则上更早就被挡）
```

★ `describe().sourceIdentityStrength` 逐字写着
`registered-source-credential + loopback + port-registry`，并且同时带着
`transportIsNotASandbox: true`。这句自述是**负责任的**部分：

* 它防的是"别的本机进程或一个浏览器页面冒充 Active"；
* 它**不是** OS 沙箱，也**不**防"同一个 Windows 用户下已经能读到 Active
  配置的人"。这一点写在这里，而不是留给读者推断。

### 3.2 管道登记为什么是**一个专用端口**

开发期实测踩到的一个真实故障：把客户端 socket 绑到**已经被监听**的端口在
Windows 上会一直失败（`bind EADDRINUSE 127.0.0.1:<IB_ACTIVE_PORT>`，三次
就地重试都不行）—— 那不是 TIME_WAIT，而是"这个地址已经被占用"。
因此来源端口是**第三条**端口：

```text
IB_ECONOMY_CHANNEL_SOURCE_PORT    ← 确定、被登记、**不被任何人监听**
```

它同时满足"来源管道"这条登记要的三件事（确定 / 被登记 / 实际被使用），
而 `SO_REUSEADDR` + 有界的就地重试只是它的第二道保险（`bind` 的失败**不**
消耗重试预算，因为它既不是"已送达"也不是"确定没送达"）。

---

## §4 Command payload 保持最小

信封**恰好四个**键：

```text
command · commandId · idempotencyKey · proposal
```

* `proposal` **原样**交给 P22-10 → P22-8，通道一个字都不解释它；
* `capability` 不在信封里（它由 command 映射得出）；
* `consumer` 更不在（它由来源登记册得出）。

★ **传输层不复制 P22-8 的经济事实黑名单。** 通道里不认识
`amountMinor` / `currency` / `price` / `budget` / `wallet` / `approvalId` /
`settlementType` / `grantQuantity` / `autoAllow` 中**任何**一个 —— 它们全部
由 P22-8 的 `MODEL_SUPPLIED_ECONOMIC_FACT` 列名拒绝（测试 E3/E4 逐字断言
这件事，并断言 `MODEL_SUPPLIED_ECONOMIC_FACT` 这个名字**不在**通道代码里）。
唯一的交叉项是 `autoAllow`：它既是本阶段 §3 逐字要求拒的一个键，也是
P22-8 名单里的一项 —— 那条断言把这个交叉写成事实，于是"只拒身份键"这句话
在有人加第二个经济字段时会立刻变红。

**Transport 负责 envelope；P22-10/P22-8 负责 proposal authority。**

---

## §5 唯一执行链

```text
authenticated Active command
        ↓
economyCommandChannel.dispatch       （信封 + 来源 + 幂等身份）
        ↓
P22-10 adapter.performAction         （**一处字面成员调用**）
        ↓
P22-9 bound handle → P22-8 → P22-7 → P22-6
```

handler **不能**直接 require/call 任何东西：通道模块的依赖闭包只有三个
目标（`./economy-contract.js`、`node:crypto`、`node:http`），适配器是
装配层交给它的一个对象。

### 5.1 http.js 拿到的是通道，不是适配器

```javascript
const economyCommand = deps.economyCommand || null;   // 通道
```

`http.js` 里**没有** `economyStore`、`economyCapabilityGate`、
`economyActionAdapter`、`performAction`、`economy-action-adapter` 中的任何
一个名字（测试 A3 逐字断言）。对通道的成员访问恰好**六**处：

```text
dispatch ×2（判定 + 读不出 body 时的拒绝信封）
path     ×3（凭据域判定 + route 判定 + /security 的 pathIsNotUnderEconomyReadPaths）
describe ×1（/security 的三句自述）
```

### 5.2 两条凭据域是分开的，这是设计而不是豁免

`/internal/economy/command` **不**要求桌面 token（`X-IB-Home-Token`），
因为：

* 桌面 token 回答的是"你有没有这台机器的桌面凭据"—— 它对 23114 与对任何
  本机进程是同一个答案，因此它确定不了来源身份；
* 要求两者同时出示只会让 Active 也拿到桌面 token：既没有更多保护，又把
  两套凭据的边界糊在一起。

它的准入**完全**由通道自己完成（fail closed）。桌面面与 `/economy/*` 读面
的一切仍然逐字按既有规则 —— `authorized()` 上方那段注释写明了这件事。

### 5.3 模型动作仍必经既有 sanitizer

```text
model output
  → 既有 Active 净化链（assets/js/active-diary/active-plans.js）
  → 允许的 Economy 提案动作（economy_propose_purchase）
  → Active companion 的出口路由（active/http.js: POST /economy/propose-purchase）
  → P22-11 transport（active/economy-channel-client.js）
  → P22-10 适配器
```

§9 逐字要求"只增加这一种结构化动作，不要造 dispatcher framework"。
落点：

* 动作名 `economy_propose_purchase` 是**唯一**新增的结构化动作；
* 既有封闭集 `['schedule','none','cancel_existing']` **逐字未变**，而且
  它的核心函数里**不认识任何经济动词**（P22-10 的 B2 断言这一条，它现在
  仍然为真，因为分流发生在核心函数**之外**）；
* **未知 / 畸形模型动作 fail closed**：净化器返回 `null`，调用方放弃创建；
* 出口由注入提供（`NS.activeEconomyProposalSink`）：没有注入时
  fail closed 并如实记一条日志，而不是静默成功；
* **本阶段刻意没有改任何 prompt**。给模型一个新动作名并让它去用，等于
  让"以后可能会用"变成一条已经存在的写路径。动作在净化边界上被接受，
  而生产者（提示词 / 生产出口）留给后续阶段。

---

## §6 Local-only + authentication

必须证明的六条，逐条有会失败的路径（`test_p22_11_economy_command_channel.js`）：

| 场景 | 结果 |
|---|---|
| 缺来源凭据 | `401 ECONOMY_COMMAND_MISSING_SOURCE_CREDENTIAL` |
| 错误来源凭据 | `401 ECONOMY_COMMAND_UNKNOWN_SOURCE`（与"缺凭据"是**两个**理由） |
| 凭据对但来自未登记的管道 | `401 ECONOMY_COMMAND_SOURCE_PORT_MISMATCH`（带 `expectedPort` / `observedPort`） |
| 另一个已登记身份拿自己的凭据 | 走到适配器，由**门**（P22-9）拒绝 |
| 未知 command | `404 ECONOMY_COMMAND_UNKNOWN`（`acceptedCommands` 一并带回） |
| 畸形信封 | `400`，五个不同的理由码（缺 command / 白名单外的键 / 缺 commandId / 缺 idempotencyKey / proposal 不是对象） |
| 远程（非 loopback） | 在 `isDesktopOnlyPath`（`/internal/` 前缀，与 `/economy/` 同级）上更早被 403 挡掉 |
| 通道未配置 | `503 ECONOMY_COMMAND_CHANNEL_NOT_CONFIGURED`（**不是**放行） |

★ **凭据绝不进日志**：通道的审计环里只有 `requestId · command · source ·
result/linkage · timestamp`（恰好八个字段，测试 C4 逐字断言），响应里也没有；
`describe()` 只给出"有哪些来源、它们的 consumer 与端口"，**不给** token。
测试 D1 在**两个真实进程**的 stdout+stderr 上断言那个 token 一次都不出现。

---

## §7 Idempotency

两层，各司其职，**不重叠**：

```text
① 通道层：commandId → 请求指纹（有界内存映射，重启即忘）
     · 同一 commandId + 同一内容 ⇒ 放行（并如实标记 channelReplay: true）
     · 同一 commandId + 不同内容 ⇒ 409 ECONOMY_COMMAND_ID_CONFLICT，且**没碰适配器**
② canonical 层：P22-8 的 idempotencyKey + intent 指纹
     · 同一逻辑 Intent ⇒ 同一条 canonical 行，replayed 位由 P22-8 置
```

★ 通道层**只**判断身份冲突，**绝不**缓存结果。一个把结果缓存的通道会让
§7 的"最终仍复用 P22-8 canonical idempotency"退化成一句注释，而且会在
"P22-8 因为崩溃恢复改了结局"时给出陈旧答案。测试 F2 的证伪形式很具体：
第二次调用的结果里带着 P22-8 自己置的 `replayed: true`，而**第一次**没有 ——
若通道缓存了第一次的结果，它只能把那份（没有 `replayed` 的）原样吐回去。

### 7.1 一个真实发现：意图指纹不看 `reason`

`PURCHASE_INTENT_FINGERPRINT_KEYS = ['agentId','productId','recipientId','units','selfDirected']`。

因此"同一个 agent 买同一个商品、只换了 reason"是**同一条逻辑 Intent**
（这正是 P22-8 想要的）。开发期实测踩到过：测试用不同的 `reason` 造
"不同的购买"，于是所有"钱真的动了"的断言**静默地**测同一笔购买。
本阶段的测试 fixture 因此显式用 `units` 区分不同购买，并把这件事写在文件头。

---

## §8 Timeout / retry

Active 侧：

```text
bounded timeout      默认 5s（250ms – 30s 之间可配）
bounded retry        默认 2 次（首次 + 一次重试），**硬上限 3**
                     请求 99 次 → 契约夹回硬上限（测试 G1 逐字断言）
bind 冲突的就地重试   有界（HARD_MAX_ATTEMPTS 次），且**不消耗**重试预算
```

失败只能表达三类：

```text
DELIVERED           服务端给出了**确定**的答案（200 或一条有名字的 4xx）
DELIVERY_UNKNOWN    可能已送达（超时 / 读不懂响应 / 5xx / 连接错误）
TRANSPORT_FAILED    确定没送达（客户端未配置 / 调用形状就不对）
```

★ `purchaseFailed` 与 `purchaseDenied` 在**每一个**客户端返回值上恒
`false`，`intentCreated` 只在服务端真的回了 intentId 时才不是 `null`。
测试 E1 用**真实进程边界**证明这件事：把 Home Node 停掉之后再发一次，
Active 侧的回答只能是 `DELIVERY_UNKNOWN / TRANSPORT_FAILED`，绝不是
"购买失败 / 被拒绝"。

★ 重试使用**同一个** `commandId` 与同一个 `idempotencyKey`（默认由
`createCommandIdentity` 生成一次并复用），因此"重试收敛到同一个 logical
Intent"由 P22-8 的 canonical 幂等保证，而不是由本地缓存保证。

---

## §9 Audit

通道只记这五样 + 结果：

```text
requestId(commandId) · command · source identity · result/linkage(intentId) · timestamp
```

它**不**复制 Economy 的 Ledger / Purchase audit（那是 store 的 canonical 事实），
也不记 payload。测试 C4 断言审计行的键集合**恰好**是那八个，且失败路径的行
里没有 payload / 金额字段。

---

## §10 HTTP / MCP / UI 边界

| 面 | 状态 |
|---|---|
| 普通 `POST/PUT/PATCH/DELETE /economy/*` | **0**（仍然是 405 `economy-is-read-only`；真实进程上逐名断言） |
| 本阶段新增的 HTTP 面 | **1** 条：`POST /internal/economy/command`（authenticated internal command endpoint） |
| MCP Economy tools | **0** |
| UI | **0** |
| Provider mutation | **0** |
| Payment | **0** |
| 真实转账 | **0** |

`/security` 的 `economyPolicy.commandChannel` 把它写成可断言字段：

```text
implemented · open · commandWritesExposed（恰好一条）· sourceCount ·
identityComesFromTheTransportNotThePayload · capabilityWritesExposed([]) ·
approvalWritesExposed([]) · resumeWritesExposed([]) ·
pathIsNotUnderEconomyReadPaths · transportIsNotAnEconomyAuthority
```

★ **装配了但关着**（生产未配置凭据）时 `commandWritesExposed` 是**空**名单：
"不可达的写面"与"可达的写面"在审计里必须是两个答案。

---

## §11 进程资源纪律

```text
max concurrent child = 2
total spawn          = 2
leftover child       = 0
```

* 单进程能证明的（认证 / 来源 / 信封 / 幂等 / 超时）一个 child 都不开：
  `test_p22_11_economy_command_channel.js` 是 **0 child**；
* 只有 `test_p22_11_economy_active_bridge.js` 开两个：Home Node 的生产启动
  路径 + Active companion 的组合根，一对 fixture 的生命周期里跑完全部用例；
* 两个 child 都只加载最小依赖闭包，**没有** Desktop / Electron / Playwright /
  浏览器 / DSH / IB UI；
* 两个 child 都走**合作停止面**（`/__shutdown` + 同一份拆除梯子），等 exit，
  不 detached，超时有上限；
* 主要加载模块：
  * Home Node —— `services/home-node-service.js` → `services/home-node/http.js`、`economy-store.js`（node:sqlite）、`economy-capability.js`、`economy-action-adapter.js`、`economy-command-channel.js`；
  * Active —— `services/active-message-service.js` → `active/http.js`、`active/scheduler.js`、`active/economy-channel-client.js`。

### 11.1 开发期实测踩到的两个真实缺陷（都已修）

1. **`buildHomeNode` 从未转发 `options.economyActionAdapter`。**
   `economyAssembly` 明确支持这个注入点（P22-10 写的），但装配层没有把它
   传下去 —— 于是"注入一个适配器"被静默忽略。症状极具误导性：包装器的
   调用计数恒为 0，而命令照样成功（因为内部自建的那一个在工作）。
   这与这个文件里已经出现过三次的病同形（memory / understanding / moments
   的"装配好了但没接上"），只是这一次的受害者是**注入点**。
2. **测试 fixture 的退出账读的是一批裸 `ChildProcess`。**
   `spawned.push(child)` 而不是 `spawned.push(svc)`，于是每一步都看起来
   "还活着" —— 一个测不到的残留恰恰会让"没有残留"变成假绿。

---

## §12 证据

```text
P22 全量（27 个文件）
  test_p22_1_economy_boundary          150 checks
  test_p22_1_economy_domain_contract   307
  test_p22_2_economy_store             210
  test_p22_2_economy_runtime            67
  test_p22_3_economy_reservation       314
  test_p22_3_economy_runtime            56
  test_p22_4_economy_budget            141
  test_p22_4_economy_quote             122
  test_p22_4_economy_runtime            48
  test_p22_5_economy_catalog           141
  test_p22_5_economy_inventory          99
  test_p22_5_economy_runtime            40
  test_p22_6_economy_purchase          109
  test_p22_6_economy_settlement        102
  test_p22_6_economy_runtime            36
  test_p22_7_economy_approval           59
  test_p22_7_economy_autonomy           67
  test_p22_7_economy_runtime            43
  test_p22_8_economy_intent             73
  test_p22_8_economy_decision_bridge    98
  test_p22_8_economy_runtime            91
  test_p22_9_economy_capability         66
  test_p22_9_economy_runtime            20
  test_p22_10_economy_action_adapter    53
  test_p22_10_economy_active_runtime    20
  test_p22_11_economy_command_channel   65   ← 本阶段新增（0 child）
  test_p22_11_economy_active_bridge     17   ← 本阶段新增（2 child / 0 leftover）
  ---------------------------------------------------------------
  合计 2614 checks · 0 failed（提交后复跑，逐文件 0 failed）
```

### 12.1 本阶段修改的既有断言（四类，逐条有理由）

| 断言 | 为什么必须改 |
|---|---|
| `test_p22_1` B2.1 / B15.1 / B15.2 / B15.2b | 磁盘上多了**第五**个 `economy-*.js`（通道）。清单必须跟着能力长，否则新文件会落在边界检查之外。B15.2b 同时把 `node:crypto` / `node:http` 的**允许用法**写成逐字限制（各自恰好一处、没有 `createServer`、没有 `.listen(`）。 |
| `test_p22_1` B3.7 | 从"一个字都不能有"变成**逐项点名**：不起进程（child_process / worker_threads）、不自己开网络（net / dgram / tls）、更不开第二个 HTTP 服务器。 |
| `test_p22_1` B12.8 / B13.10 / B15.14 | 定时器禁令的意图是"到期是**比较** `expires_at <= now`，不是某个调度"。通道需要的是**一次出站请求的最后期限与重试退避**，因此豁免写成精确形式：只有一个文件、恰好两处 `setTimeout`、零 `setInterval`、零到期扫描。 |
| `test_p22_1` B4.2 / `test_p22_6` K6 / `test_p22_10` A6 | 装配层对 Economy 的 require 从三处变成**四处**（第四处是通道；通道长在适配器上面，装配是它唯一的构造点与唯一的来源登记处）。 |
| `test_p22_10` B2 | 既有封闭动作集**逐字未变**这句话仍然为真，但它的形状变了：核心函数被原样保留为 `_activeValidatePlanResultCore`，而分流发生在**它之外**。断言改成对这个形状的核对。 |
| `test_p22_10` B3 / B6 | "Active runtime 每一个文件里零经济引用"在 P22-11 之后**有意**不再为真。豁免写成一个**精确的**四文件清单（出站腿 / 出口路由 / 组合根 / 既有净化链），其余**每一个** Active 文件仍然必须是零引用 —— 断言因此变成了"没有**未解释**的引用"。 |

★ 一条**没有**被改的断言值得点名：`test_p22_10` 的 H5（"适配器**没有**出现
在任何 HTTP 路由上"）仍然为真 —— `http.js` 里没有 `economyActionAdapter`、
没有 `performAction`、没有 `economy-action-adapter`。P22-11 交给路由层的是
**通道**，而通道的公开面里没有适配器。

### 12.2 复跑

```text
tests/test_p22_11_economy_command_channel.js   连跑 3 次：全绿（端口与幂等无抖动）
tests/test_p22_11_economy_active_bridge.js     连跑 2 次：全绿，且两次都是 2/2/0
tests/test_p22_5_economy_runtime.js            连跑 2 次：全绿（见下面的已知抖动）
```

### 12.3 aggregate（提交后）

```text
static  108 项 · 373.6s · 4 失败
service  29 项 · 109.2s · 全部通过
browser  66 项 · 869.2s · 11 失败（全部为基线失败：Home Node offline / CDP 面）
```

那 4 项 static 失败逐条说明：

| 失败项 | 判定 |
|---|---|
| `test_cache_audit.js` | **已知基线失败**（economy 引用为 0，全量前提交前同款） |
| `test_middle_brain_convergence_counterproof.js` | **已知基线失败**（变异 harness 起不来，economy 引用为 0） |
| `test_p22_7_economy_runtime.js` | **负载抖动**：D8（两个真实进程同时决定同一条批准）在 aggregate 的一次运行里少了一个见证进程的读数。单跑 / 连跑 **2 次全绿**。 |
| `test_p22_8_economy_runtime.js` | **负载抖动**：D6a（两个见证人的读数必须逐字一致）同源。单跑 / 连跑 **2 次全绿**。 |

★ 这两条与 P22-5 的 E1 是**同一类**：多进程 race 组在机器被 aggregate
压满时会出现 SQLite 写锁竞争（`db-busy`），而它们的断言对时序敏感。
本阶段没有改 `economy-store.js`、也没有改这两个文件，因此**不是** P22-11
引入的回归 —— 但这条记录留在这里，让下一个人不必重新判定一次。

### 12.4 一条**没有**被本阶段顺手修掉的既有抖动

在全量 aggregate 的**前一次**运行里，`test_p22_5_economy_runtime.js` 的
E1 组也出现过一次 `db-busy — database is locked`（四个真实 worker 同时
`open()` 同一个库；`open()` 遇到 SQLITE_BUSY 时没有重试）。
它单跑与连跑都是绿的，而且本阶段没有改 `economy-store.js`、`open()` 或
那个 worker fixture。

⇒ 判定：**既有的、由机器负载诱发的抖动**，不是 P22-11 引入的回归。
它**没有**被本阶段顺手修掉 —— 那属于 P22-5 的领域，而 P22-11 的范围
纪律不允许顺手改别的模块。这条记录留在这里，是为了让下一个人不必再
花时间重新判定它是谁的问题。

---

## §13 本阶段**没有**做的事（逐条说明，而不是省略）

1. **没有改任何 prompt。** 动作在净化边界上被接受，生产者留给后续阶段。
   ★ 这有一个直接后果，必须说清楚：**今天没有任何生产代码会主动发出
   `economy_propose_purchase`**。通道的一侧（Home Node handler → P22-10 →
   P22-9 → P22-8 → P22-7 → P22-6）是**完整且被真实进程验证过的**；另一侧
   （谁在什么条件下决定要提议）本阶段只提供了**入口**（Active 的净化器
   接受这种动作、`active/http.js` 有一条出口路由、companion 有客户端），
   而**没有**提供生产者。
2. **没有接 resume / approve / buy / settle。** 见 §2。
3. **没有开 Approval UI / 用户批准入口。** P22-10 §9 的
   `NO_APPROVAL_TRIGGER_SEAM` 依然成立。
4. **没有 MCP / Chat / Group / Voice / Diary / 商店 UI / 素材 / Exchange /
   Refund / 真实 Provider quota / 真实支付。**
5. **没有为 Economy 新造 transport framework。** 见 §1.1。
6. **没有把凭据写进任何文件。** 来源凭据由部署环境提供
   （`IB_ECONOMY_CHANNEL_TOKEN`）；装配层不生成、不落盘、不打日志。
7. **没有做 OS 级的来源证明。** 见 §3.1：谁控制一个端口不由本层回答，
   本层给出的是"注册来源凭据 + loopback + 端口登记"，并把它的分量写下来。

---

## §14 生产启用需要什么（部署视角）

```text
23118（Home Node）
  IB_ECONOMY_CHANNEL_TOKEN=<与下面同一个值>      ← 没有它通道是**关**的
  IB_ECONOMY_CHANNEL_SOURCE_PORT=<专用出站端口>   ← 登记来源管道
23114（Active companion）
  IB_ECONOMY_CHANNEL_TOKEN=<与上面同一个值>
  IB_ECONOMY_CHANNEL_SOURCE_PORT=<同一端口>
  IB_ECONOMY_CHANNEL_BASE=http://127.0.0.1:<Home Node 端口>   （可选，默认 23118）
```

未配置时的姿态是**关**（`503` / `/security` 报 `open:false`），不是"回落到
匿名" —— 一条写路径不继承本机 loopback 的零门槛姿态。
