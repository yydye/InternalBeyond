# P22-0 · Agent Economy 只读审计（Read-only Audit）

> 本文件是 **P22-0 的交付物**，也是 P22-1～P22-12 的架构前提。
> 审计基线：`master @ 36db789`（InternalBeyond 1.0.5）。
> **本阶段零生产文件改动**（仅新增本审计文件）。

审计结论一句话：

> **可以在不破坏 Memory / Relationship / Decision / Action canonical ownership 的条件下实现 P22**，
> 但必须先承认两个既有事实：(1) 仓库里**已经存在一套真实支付子系统**（Alipay），
> Economy 必须与之**结构性隔离**而不是"约定不调用"；(2) 仓库里**不存在**名为 "Decision" 或
> "Action" 的独立模块 —— 它们以**既有形状**存在（`active/commerce.js` 的 intent 状态机、
> `PaymentIntent`、**工具回合 + Middle Brain 裁决**），Economy 必须适配这些形状，而不是新造。

---

## 0. 审计方法

- 先读 `git status` / `git log`，确认工作区基线。
- 按 **"谁是 canonical owner"** 而不是按文件名检索：用符号检索（`DB_VER`、`SCHEMA_VERSION`、
  `change_log`、`reasoningEffort`、`affection`、`actionId`、`decisionId` …）反查真实写入点。
- 每一个断言都附 `文件:符号` 形式的代码证据。
- 对"不存在"的结论同样给证据（grep 命中为空也是证据）。

---

## 1. Economy 可以接入的 canonical runtime seam

### 1.1 唯一可用的接缝：Home Node（Node 侧 canonical 权威）

`services/home-node-service.js` 是**唯一**的 canonical 服务装配点，导出两套等价装配路径：

| 路径 | 位置 | 用途 |
|---|---|---|
| 测试/嵌入装配 | `buildHomeNode(options)` → `open()` / `close()` | `home-node-service.js:451` / `:594` / `:602` |
| 生产进程装配 | `openAll()` / `shutdown(reason)` | `home-node-service.js:780` / `:912` |

**周期性铁律（已有三次事故记录，见 §14 R3）**：两条装配路径必须开/关**同一组** store。
Moments 曾漏一次（`P11-3E`，注释在 `home-node-service.js:775-779` 明确记录了
"production 的 `openAll()` 从来没打开过它"，症状是 `/moments/*` 503/500 而所有直接
`createMomentsStore()` 的测试全绿）。Economy 若加 store，**必须同时进这两处**，并由
真实子进程断言锁死。

### 1.2 Economy 应挂载的位置

```text
services/home-node/
├── chat-store.js          ← canonical chat（已有）
├── memory-store.js        ← canonical memory（已有）
├── understanding-store.js ← canonical understanding（已有）
├── moments-store.js       ← canonical moments（已有）
├── device-registry.js     ← characters / devices / pairing（已有）
├── economy/               ← ★ P22 新增（唯一新目录）
│   ├── ledger-store.js
│   ├── wallet.js
│   ├── transaction-engine.js
│   ├── reservation.js
│   ├── budget-policy.js
│   ├── store-catalog.js
│   ├── inventory.js
│   ├── exchange.js
│   ├── compute-credits.js
│   ├── audit.js
│   └── purchase-orchestrator.js
└── http.js                ← 唯一的 HTTP 面（新增 /economy/* 路由）
```

### 1.3 HTTP 授权面（必须遵守）

`services/home-node/http.js` 存在一份 **verb 白名单 + 显式不暴露清单**：

- 路径白名单：`http.js:639-640`（`loopbackReadableWithoutToken`）、
  `ADMIN_PATHS`（记忆域 `http.js:657-658`、理解域 `:671`、Moments 域 `:690`）。
- 显式不暴露：`http.js:692` → `doesNotExpose: ['llm-proxy', 'tools', 'payments', 'diary', 'letters', 'images', 'tts']`。
- 移动面 verb 清单：`http.js:699-701`（`verbs: [...]`）。
- 凭据铸造路径需 desktop token：`http.js:633-638`。

**结论**：`'payments'` 已经在 `doesNotExpose` 里。Economy 的 `/economy/*` 应加入
`ADMIN_PATHS`（桌面/运行时面）并**保持 `deviceVerbs: []`**——与
`memoryPolicy.deviceVerbs: []`（`http.js:655`）、`understandingPolicy`（`:666`）、
`momentsPolicy`（`:686`）同款。经济状态是**本机私有状态**，不是设备面能力。

### 1.4 失败分类与健康聚合（复用，禁止第二套）

- 唯一失败分类器：`runtime/db-failure.js`（`classify` / `isDatabaseError`），
  由 `home-node-service.js:568-569` 注入 http 层。
- 唯一 store 失败分类：`services/home-node/http.js` 的 `resolveStoreFailure` +
  `createStoreFailureProbe`（Moments 的探针在 `home-node-service.js:346`）。
- store 清单：`home-node-service.js:575-581`（`stores: [{store, name, role}]`）。
  Economy store 若加，必须在此登记 `{ name: 'economy', role: 'canonical-economy-authority', probe }`。

---

## 2. Memory canonical owner

**唯一 canonical 权威 = Home Node 的 `memory_records` 表**（与 chat 同一个 `home-node.db`）。

| 角色 | 文件 | 关键符号 |
|---|---|---|
| canonical store（Node） | `services/home-node/memory-store.js` | `MEMORY_SCHEMA_VERSION = 1` (`:53`)、`memory_records`、`memory_change_log` (`:55`)、`recordActivation`（**不**推进 revision，`:36`） |
| 运行时中立契约 | `assets/js/memory-contract.js` | `MEMORY_STORE='memories'`、`TELEMETRY_FIELDS`、`contentFingerprint`、`ownerIdOf`（缺省 `'user'`，`:78-82`）、`validateRecord` |
| 三态客户端（浏览器） | `assets/js/memory-authority.js` | `MODES = ['canonical','mirror','off']` (`:48`)、`createMemoryAuthority` (`:53`)、canonical 模式下写失败 **fail closed**（`:265` `'home-node-offline'` + hint「记忆写入已停止（fail closed），没有写入第二份 canonical」） |
| 镜像 | IndexedDB `memories` store | `assets/js/core.js:4`（DB_VER 23 的 store 列表） |
| 检索 | `services/home-node/memory-retrieval.js` | 只在**本机执行缝**注入 |

**关键既有不变量（Economy 必须继承）**：
- `revision` + `change_log` 是**独立命名空间**（`memory-store.js:12-13` 明确：
  "若共用 chat 的 change_log，一次记忆写入会让**聊天**镜像游标失效"）。
- 内容等价判定**剔除遥测字段**（`memory-contract.js:31-38`）——否则迁移幂等性立刻失效。
- **P11-3F 的 hydrate/envelope 事故**（用户点名的"之前 Memory hydrate / envelope 类问题"）
  证据在 `tests/test_p11_3f_moments_hydration_safety.js`（67 KB）与
  `tests/test_home_node_client_envelope.js`。Economy 若做客户端镜像，**必须**先读这两个测试。

---

## 3. Relationship canonical owner

**这是一个分裂的双 owner，必须分别对待。**

| 数据 | 存储 | 权威文件 | 语义 |
|---|---|---|---|
| **有向角色间关系**（`trust` / `familiarity` / `affinity`） | **localStorage** key `ib_role_dm_relations_v1` | `assets/js/role-dm.js`（`KEY_RELATIONS` `:69`、`relationsAll` `:219`、`relationGet/Save` `:237/:242`、`observeRun` `:968`、`relationSave` `:1060`） | A→B 与 B→A **各一条** |
| **角色卡上对用户的关系描述** | IndexedDB `apiConfigs[].relationship` | `assets/js/communication.js`、`active/model-client.js:157` | 一句话描述，**不是**数值 |

契约与算法真源：`assets/js/role-dm-core.js`
- `RELATION_DIMS = ['trust','familiarity','affinity']`（`:112`）
- `RELATION_DEFAULT = { trust: 0.5, familiarity: 0.2, affinity: 0.5 }`（`:113`）
- `RELATION_DELTA_CAP = 0.03`（**单次 run 任一维度的最大改动量**，`:117`）
- `RELATION_MIN/MAX = 0/1`（`:114-115`）
- `RELATION_ID_PREFIX = 'roleRel_'`（`:52`）、`applyRelationDelta`、`relationDelta`

**Economy 的硬边界**：
- Economy **禁止** `affection += X` / `trust += X`。检索 `affection\s*[+\-]?=` 在
  `assets/js` + `active` + `services` 下**命中为空**——即当前生产代码里**根本不存在**这种写法，
  Economy 不得成为第一个。
- Economy 只能产生 **event**（如 `economy.purchase.completed`）。
  Relationship 是否变化、变化多少，仍由 `role-dm.js:observeRun()` →
  `role-dm-core.applyRelationDelta()`（受 `RELATION_DELTA_CAP` 封顶）决定。
- 注意 `role-dm.js:483-489` 已经把两个"关系"来源区分清楚
  （`selfRelationshipToUser` = 角色卡字段；`peerRelationship` = 有向关系记录）。
  Economy 不得把两者混用，也不得新增第三个。

---

## 4. Decision canonical owner

**不存在名为 Decision 的独立模块。** 检索 `decisionId` 在
`assets/js` + `active` + `services` 下**无任何命中**。

Decision 以**三种既有形状**存在：

### 4.1 自主任务决策（最接近 P22 的场景）

`active/active-plans.js` + `active/scheduler.js`：
- 持久化字段含 `intent`（`:58`、`:124`、`:318`）与 `reason`（`:682`）
- 计划 → 任务：`scheduledAt`、`characterId`、`intent`（`:242`、`:318`）
- IndexedDB store：`active_message_plans`（`assets/js/core.js:4`，带 `byCharacter` 索引）
- 这是**已有的"角色自主意图"载体**，Economy 应当**读取**它，而不是另建 intent 表。

### 4.2 购物决策状态机（既有，且连着真实支付）

`active/commerce.js`：
- `a.intent` 状态机：`SEARCH → OBSERVE → COMPARE → SELECT → SKU → REVIEW → CHECKOUT`
  （`:380`、`:538`、`:543`、`:551`、`:575-579`、`:592`、`:605`、`:615`、`:709`）
- `a.paymentIntent = { orderId, checkoutUrl, ... }`（`:528-538`）
- `maxBudget`（**元**，真实货币，`:572`：`'候选均超过预算 ' + a.task.maxBudget + ' 元'`）
- `_halt(STOP_REASON.OVER_BUDGET, ...)`（`:572`）

**这是一个已经存在的"预算"概念，但单位是人民币、且通向真实支付。**
P22 的 Budget Policy **绝不能**复用 `a.task.maxBudget`，否则虚拟预算与真实预算会互相污染。

### 4.3 真实支付的授权域

`active/payment-auth.js`（授权唯一来源）+ `bridge/pay-gate.js`（服务端唯一提交入口）。

**P22 的 Decision 适配点**：`Purchase Intent` 应当是一个**新对象**，
其来源可以是 (a) `active-plans.js` 的 plan intent，或 (b) AI 回合中的工具调用参数。
它**不是** `PaymentIntent`，两者必须有不同的类型名与不同的持久化命名空间。

---

## 5. Action canonical owner

**不存在名为 Action / actionId 的独立 executor。** 检索 `actionId`、`executeAction`、
`ActionPipeline` 在 `assets/js` + `active` + `services` 下**全部无命中**。

Action 的 canonical 管道是**"工具回合 + Middle Brain 裁决"**：

| 层 | 文件 | 关键符号 |
|---|---|---|
| 浏览器工具循环 | `assets/js/integrations.js` | `IBMCP.execOp`、`IBMCP.cfg()`、`IBMCP.save()`、`ib_fcMode` / `ib_fcRounds` / `ib_fcMaxToolCalls` / `ib_fcToolTimeoutMs`（`:260`、`:274`、`:327`、`:334`、`:1107`） |
| 执行前裁定 | `assets/js/tool-execution-guard.js` | `REASONS`（封闭集合，`:42-51`）、`DEFAULT_POLICY`（`:67-76`）、`SENSITIVE_KEY_RE`（`:81`）、`IBFC._newGuard`（每 host turn 一个独立 guard） |
| Middle Brain 门面 | `assets/js/middle-brain.js` | `__middleBrainContracts`（`:27`）、`middleBrainExecute`（`:6`、`:18`）、`middleBrainFinalizeReply`（`:21`）、`_MB_TRACE_FIELDS`（`:44-47`） |
| Node 角色回合 | `services/home-node/execution.js` | `createTurnExecutor`（`:40`）、`executeCharacterTurn`、`requestId` = transport 级幂等键（`:21-26`）、`deps.middleBrain` **可选缝**（`:46-50`） |
| 副作用闸 | `assets/js/middle-brain-integrity.js`、`middle-brain-policy.js` | `sideEffectsSuppressed` / `sideEffectCategories`（`middle-brain.js:43`）、`policyDecision: 'allow'\|'deny'\|'unverified'`（`:53`） |

**冻结不变量（P11-3D.1，关闭于 `574193a`）**：
> ONE HOST AI TURN = ONE TOOL EXECUTION CYCLE = ONE TOTAL BUDGET。
> owner 是宿主 turn，不是一次 `callApiChat*`。禁止全局 mutable guard、
> 禁止在 storage 存活动周期、禁止"XML 通道单独建第二个预算"。

**Economy 的硬边界**：购买/赠送/使用**必须**经工具回合（`IBMCP.execOp` 路径）或
`execution.js` 的既有缝进入 Middle Brain 裁决。Economy **不得**建第二个 action executor，
**不得**绕过 `tool-execution-guard.js`。

---

## 6. Provider Router canonical owner

**唯一 wire 层真源 = `assets/js/ib-model-core.js`**（UMD 双载，`require('./provider-directory.js')` at `:12`）。

- `PROVIDERS = CANON.PROVIDERS`（`:20`）—— 表来自 `provider-directory.js`，**不复制**。
- `providerFormat` / `resolveProviderFormat`（`:27`、`:32`）委托 canonical。
- `buildRequestBody` / `parseResponse` / `createStreamParser` —— `execution.js:17-19` 明确：
  「两者共用同一份 wire 层……**禁止在本文件里出现 provider 字段名判断**」。
- Node 侧消费者：`active/node-model-port.js`（`runStream`）、`active/model-client.js`、
  `active/node-model-compat.js`。

**Provider metadata 唯一源 = `assets/js/provider-directory.js`**（用户 P4 已冻结的契约：
「provider metadata 唯一源为 `assets/js/provider-directory.js`，禁止复制 endpoint/model/format 等元数据」）。

**Economy 的硬边界**：Compute Budget 适配器**只能**在 `ib-model-core` **之前**做
"允许 / 降级 / 拒绝"的判定，**不得**读 provider 目录去自己维护第二份能力表，
**不得**改 `buildRequestBody` 的输出。

---

## 7. reasoningEffort canonical owner

**唯一能力真源 = `assets/js/provider-directory.js:246-...`（P21 建立）**：

- `REASONING_TIERS = ['auto','low','medium','high','max']`（`:288`）
- `REASONING_LADDER = ['minimal','low','medium','high','xhigh','max']`（`:291`）
- `REASONING_CAPABILITIES`（key = provider id，`:293`）—— 含 `verified` / `appliesToAllModels` /
  `kind` / `wire`
- `REASONING_MODEL_POLICIES`（key = **官方 model id，逐条取证**，`:318`）
- `REASONING_PENDING`（审计元数据，**不参与运行时判定**，`:281-283`）
- 注释 `:246-248` 明确："**唯一**一份 provider 思考深度能力真源"

消费方（**禁止**绕开）：
- `ib-model-core.js:115-128` → `normalizeReasoningTier` / `reasoningCapability` / `reasoningWirePlan`
  （全部委托 `CANON`，缺失时退化为 `'auto'` + `fallbackReason: 'capability_unavailable'`）
- `ib-model-core.js:191` → `applyReasoningEffort(body, spec, options)` ——**唯一**写 wire 参数的点
- `ib-model-core.js:131-174` → `_reasoningTrace` / `noteReasoningTokens` / `reasoningTrace`
  （**只驻内存、白名单字段、绝不落盘**，`:136-137`）
- `middle-brain-config-core.js`（19 处）、`middle-brain-config.js`（13 处）、
  `middle-brain-astra.js`（10 处）、`communication.js`（21 处）

**Economy 的硬边界**：Economy 可以**消费** `compute credits` 决定"是否允许请求高档位"，
但**实际档位的合法性判定必须仍由 `reasoningCapability` / `reasoningWirePlan` 给出**。
Economy **不得**手抄任何 provider 的能力表（P11-3X-C 已有同款禁令：「禁止手抄
GPT/Claude/DeepSeek context window 表」）。

---

## 8. Agent / Character ID canonical representation

**存在两条并行的 ID 事实源，必须显式选边。**

| 面 | 载体 | 证据 |
|---|---|---|
| **浏览器（桌面）** | IndexedDB `apiConfigs` store，记录 `id` 字段 | `assets/js/core.js:4`（`apiConfigs` 在 store 列表）；用户 P4 契约：「`apiConfigs` 同时是 provider 配置与角色，是唯一事实源，**禁止创建第二套「角色表」**」 |
| **Node（canonical）** | `home-node.db` 的 `characters` 表（`id` PK + `dto_json`） | `services/home-node/device-registry.js:208-213` |
| **Node 运行时密钥** | `character_runtime_specs` 表（`character_id` PK + `spec_json`） | `device-registry.js:214-219` |
| **名称解析** | `characterNameOf(roleId)` → `store.getCharacter(id).dto.nickname \|\| .model` | `home-node-service.js:322-329` |
| **派生 ID 形状** | `dm:`（`chat-core.js:104` `conversationIdOf(friendId)`）、`group_<ms>`、`roledm_<token>`（`role-dm-core.js:42`）、`roleDm_` / `roledmmsg_` / `roleRel_`（`:50-52`） | — |

**`characters` 与 `character_runtime_specs` 刻意分表**，理由在
`device-registry.js:592-597` 逐字写明：

> `characters` —— mobile-safe DTO，**可以**发给任何已认证设备；
> `character_runtime_specs` —— provider 凭据与运行参数，**永不**离开 Node。
> 分开而不是"一个 JSON 里挑字段"，是因为"挑字段"的实现一旦漏了一个键就会泄漏；
> 分表之后泄漏需要有人显式把 secrets 表 join 进 DTO 路径。

**这是 Economy 安全边界的关键既有机制**：Economy 的 Wallet `ownerId`
**只允许**取 `characters.id`（DTO 面），**永远不得** join `character_runtime_specs`。
Economy 只读 `characters` 即可满足全部需求（不需要凭据）。

---

## 9. 当前持久化层与 schema / version 机制

### 9.1 三层持久化（**不要新建第四套**）

| 层 | 载体 | 版本机制 |
|---|---|---|
| 浏览器 | IndexedDB `InternalBeyondDB` **DB_VER = 23**，**32 个 object store** | `assets/js/core.js:3-4`（`openDB()` / `onupgradeneeded`）；`chat-core.js:22` 镜像 `DB_VER`（注释：**与本阶段不升版**） |
| Node canonical | SQLite `%LOCALAPPDATA%\InternalBeyond\home-node\home-node.db`（`node:sqlite`，**零 npm 依赖**） | `home-node-service.js:21`；`IB_HOME_NODE_DATA_DIR` 可覆盖（`:63`） |
| 小状态 | `localStorage`（如 `ib_role_dm_relations_v1`） | `role-dm.js:69` |

### 9.2 `home-node.db` 的多命名空间设计（Economy 必须照抄）

**同一个 `home-node.db` 文件，每个域自带 schema 版本与 revision 命名空间**：

| 域 | schema 版本符号 | revision 命名空间 | change_log 表 |
|---|---|---|---|
| chat | `chat-store.js:38` `SCHEMA_VERSION = CHAT_CORE.SCHEMA_VERSION`（=1） | `meta['revision']` | `change_log`（`:132`） |
| memory | `memory-store.js:53` `MEMORY_SCHEMA_VERSION = 1` | `meta['memory_revision']` | `memory_change_log`（`:55`） |
| understanding | `understanding-store.js` | 自有 | 自有 |
| moments | `moments-store.js` | `moments_revision` | 自有（含软删墓碑） |
| devices | `device-registry.js:43` `SCHEMA_VERSION = 1` | `meta['devices_schema']` | — |

**版本写入规则（每个 store 都一样）**：
- 首次：`if (stored == null) writeMeta('<ns>_schema', String(SCHEMA_VERSION))`
  （`chat-store.js:251`、`device-registry.js:267`）
- **schema 过新即拒绝服务**：`chat-store.js:252-254`
  `'chat store schema is newer than this build (' + stored + ' > ' + SCHEMA_VERSION + ')'`
  → 分类为 `db-schema-too-new`（`runtime/db-failure.js`）
- PRAGMA 统一：`journal_mode = WAL` / `synchronous = FULL` / `busy_timeout = 5000` /
  `foreign_keys = ON`（`chat-store.js:239-242`）
- 损坏隔离：`chat-store.js` 负责给坏库改名（`:277` `recoveredFromCorrupt`），
  **所以 chat store 必须先开**（`home-node-service.js:590-593` 注释）
- 幂等表：`idempotency`（`chat-store.js:140`）
- 迁移状态：`getMigrationState` / `setMigrationState`（`chat-store.js:862` / `:878`）

**Economy 应新增自己的 `economy_schema` + `economy_revision` + `economy_change_log`
（或 append-only ledger 本身即 change log），绝不共用 chat/memory 的 revision。**

### 9.3 数据迁移纪律（用户 P22 §18 + 既有事故）

- `assets/js/core.js` 的 `openDB()` 用 `onupgradeneeded` + `if (!d.objectStoreNames.contains(s))`
  —— **只会新增，不会清空**。新 store 必须加进 `:4` 的数组。
- **升 DB_VER 的代价已被明确记录**：`role-dm.js:63`
  「兼容优先，不轻易升 DB_VER，而新增 store 会强制升版并牵动多处硬编码」，
  `role-dm-core.js:266`、`active-diary.js:704`/`:934`、`setup-wizard.js:14` 都有
  「**不升 DB_VER**」的明确约束。
- 用户 P4 契约：首启/向导状态只写 `apiSettings` 私有 key，**不得升 DB_VER**。
- `chat-core.js:22` 的 `DB_VER = 23` 与 `core.js:3` **必须同步**（注释逐字要求）。

---

## 10. 当前 runtime trace / audit 能力

| 机制 | 位置 | 性质 |
|---|---|---|
| **store 级 change_log** | `chat-store.js:132`、`memory-store.js:55` + `moments-store.js` | **持久、可重放、带 revision 游标**——这是最接近 canonical audit 的既有机制 |
| Middle Brain trace（dev-only 观测） | `middle-brain.js:31-47` `_MB_TRACE_FIELDS`（23 + 5 字段） | **只打印、不落盘、不改判定**；白名单字段；`window.__IB_MB_TRACE` / `localStorage['ib_mb_trace']` 开关 |
| P21 reasoning trace（遥测环） | `ib-model-core.js:131-174` | **只驻内存、容量 100、绝不落盘**；白名单（provider/model/format/consumer + 4 个 reasoning 字段 + tokens + 时间）；**不含** prompt/消息/请求体/Authorization/apiKey |
| 自主行为 trace | `active/proactive-trace.js`（24 处命中） | proactive 交互的可观测记录 |
| 结构化日志 | `home-node-service.js:93` `log(level,event,fields)`、`ib-bridge-service.js` | stdout，`{"event":"shutdown"}` 等 |
| 安全面自述 | `http.js:620-704`（`credentialMintingPaths` / `memoryPolicy` / `understandingPolicy` / `momentsPolicy` / `doesNotExpose` / `deviceAuth` / `mobile`） | **可检查的结构化断言**，被测试锁定 |
| 执行台账 | `integrations.js`（工具调用台账）+ `tool-execution-guard.js` 指纹 | 指纹是 SHA-256（`tool-execution-guard.js:83-90` 解释了为何不用 `crypto.subtle`） |

**P22 的要求**：「不要把 debug log 当 canonical audit」。
Economy Audit **必须**是**持久、可查询、可追溯**的结构（建议独立 `economy_events` 表），
而不是 `console.log`。可复用的既有模式是 `change_log`（append-only + revision 游标）。

---

## 11. Economy 最小侵入接入点

按侵入度从低到高：

1. **新增目录** `services/home-node/economy/`（零既有文件改动）。
2. **`services/home-node-service.js`**：
   - 新增 `function economyAssembly(options)`（照 `momentsAssembly` `:312` 的形状）
   - `buildHomeNode().open()` 加一行（`:594-601`）、`close()` 加一行（`:602-622`）
   - `openAll()` 加一行（`:780-787`）
   - `stores[]` 加一项（`:575-581`）
   - 导出（`:623-629`）
3. **`services/home-node/http.js`**：新增 `/economy/*` 到 `ADMIN_PATHS`；
   `economyPolicy: { stored:true, servedToDevices:false, deviceVerbs:[], injection:'home-node-execution-only', desktopPaths:[...] }`
   加入 security 自述（照 `:652-691`）。
4. **`scripts/release-manifest.js`**：**必须手工登记**任何被启动链 require 的新模块
   —— 该文件是**逐文件白名单，不是 glob**（`:58-61` 注释逐字说明）。
   注意 `${from:'services/home-node', dir:true}`（`:71`）是目录级，**新目录 `economy/` 不在其中**，
   必须新增一条 `{ from: 'services/home-node/economy', dir: true, why: ... }`。
   浏览器侧 `assets` 是目录级（`:38`），新 `assets/js/*.js` 自动入包，
   但**仍需在 `InternalBeyond.html` 手工加 `<script>`**（见 `:3031`/`:3058`/`:3065`/`:3136`/`:3183` 的既有形状）。
5. **`tests/test-all.js`**：新测试**必须**登记进 `GROUPS` 的 `static` / `service` 组
   （`:110-167` 的形状），否则不会被任何回归跑到 —— 这与 Moments 漏装配是同一类
   "看不见的缺口"。
6. **Provider / reasoningEffort 适配器**：接在 `ib-model-core.buildRequestBody` **上游**
   （即调用方决定 `spec.reasoningEffort` / `spec.model` 之前），不改 wire 层。
7. **Decision / Action 适配器**：只做**只读读入**（`active-plans.js` 的 intent）
   与**经工具回合写出**（`IBMCP.execOp` / `execution.js` 缝）。

---

## 12. 哪些文件绝对不应该由 Economy 接管

### 12.1 四个 canonical 系统（用户 P22 §3 / §21）

| 系统 | 冻结文件（**只读**） |
|---|---|
| Memory | `services/home-node/memory-store.js`、`assets/js/memory-contract.js`、`assets/js/memory-authority.js`、`assets/js/memory.js`、`assets/js/memory/*.js`、`services/home-node/memory-retrieval.js` |
| Relationship | `assets/js/role-dm-core.js`（契约与 `RELATION_DELTA_CAP`）、`assets/js/role-dm.js`（`KEY_RELATIONS` 写入点） |
| Decision | `active/commerce.js`、`active/payment-auth.js`、`active/plan-domain.js`、`active/scheduler.js` |
| Action | `assets/js/middle-brain*.js`（6 个）、`assets/js/tool-execution-guard.js`、`services/home-node/execution.js`、`services/home-node/middle-brain.js`、`assets/js/integrations.js` |
| Provider | `assets/js/ib-model-core.js`、`assets/js/provider-directory.js`、`active/node-model-port.js`、`active/model-client.js` |

### 12.2 支付 / 凭据（**结构性禁入**）

| 文件 | 为什么 |
|---|---|
| `bridge/pay-gate.js` | 服务端唯一支付提交入口，`STATUS` 状态机 + `commitSpend` |
| `bridge/alipay-provider.js` | **真实支付宝**：`spawnSync('alipay-bot','submit-payment','--payment-link',url)`，`CASHIER_RE` 校验 |
| `bridge/payment-provider.js` | Provider registry |
| `active/payment-auth.js` | 授权唯一来源（`under_limit` / `each` / `disabled`） |
| `active/shopping-execution.js`、`assets/js/commerce-adapter.js`、`assets/js/shopping-review.js`、`assets/js/payment-settings.js` | 真实购物执行链 |
| `active/credential-vault.js` | **AES-256-GCM 加密的 API Key 库**（`vault[characterId].apiKey`）—— Economy 一旦注入此模块，`Economy cannot access API keys` 这条断言就不再是可证明的 |
| `services/home-node/device-registry.js` 的 `character_runtime_specs` 表 | **provider 凭据，永不离开 Node**（`:595`）—— Economy 只许读 `characters` 表 |
| `assets/js/core.js` 的 `_persistApiConfig` / `apiConfigs` 中的 `apiKey` | 唯一事实源，Economy 只读 `id` / `nickname` / `relationship` |

### 12.3 明确不在 P22 范围

`assets/js/communication.js`（381 KB，桌面单聊编排者）、`assets/js/core.js`（DB 层）、
`runtime/*`（启动链）、`installer/*`、`android/*`、`vision/*`。

---

## 13. 当前工作区状态

```
$ git rev-parse --abbrev-ref HEAD
master

$ git status --short
?? .dsh-audit/
?? .dsh-research/
?? MOBILE_HOME_NODE_AUDIT.md
?? "Mobile Master Roadmap v1.md"
```

- **HEAD = `36db789`** `fix(release): make the payload manifests and the build hash gate agree`
- **VERSION = 1.0.5**
- **已跟踪文件：零未提交修改。** 4 项均为**未跟踪**（untracked），且**均与 P22 无关**：
  - `.dsh-audit/`（21 个前次会话的探针脚本）、`.dsh-research/`（5516 个文件）—— 工具产物
  - `MOBILE_HOME_NODE_AUDIT.md`、`Mobile Master Roadmap v1.md` —— 移动端路线图文档
- **判断**：**与 P22 无冲突。** 不需要 stash、不需要清理、不需要顺手提交。
  P22 期间它们保持 untracked 状态即可。

---

## 14. P22-1 ～ P22-12 预计修改范围

> 原则：**每阶段独立提交**；新文件优先；对既有文件的改动逐条列出。
> 标 ★ 的是**必须改既有文件**（侵入点），其余全部是新增文件。

| 阶段 | 新增 | 改既有文件 ★ | 预计测试 |
|---|---|---|---|
| **P22-1 Contract** | `assets/js/economy-contract.js`（UMD 纯函数，照 `memory-contract.js` / `role-dm-core.js` 形状：零 window/DOM/IO）、`docs/P22-ECONOMY-CONTRACT.md` | — | `tests/test_p22_economy_contract.js`（纯 Node） |
| **P22-2 Ledger+Wallet** | `services/home-node/economy/ledger-store.js`（append-only + `economy_revision` + 幂等）、`wallet.js`（`cachedBalance` 可从 ledger 重建） | ★ `home-node-service.js`（assembly ×3）、★ `release-manifest.js`（新目录登记）、★ `tests/test-all.js` | `test_p22_ledger.js`（credit/debit/insufficient/rebuild/duplicate） |
| **P22-3 TX+Reservation** | `transaction-engine.js`、`reservation.js` | ★ `http.js`（`/economy/*` 路由 + `economyPolicy` 自述） | `test_p22_reservation.js`（reserve/commit/release/expired/crash-recovery/double-commit） |
| **P22-4 Budget Policy** | `budget-policy.js`（**确定性、纯函数、无 LLM 输入**） | — | `test_p22_budget.js`（per-tx/daily/weekly/category/recipient/autonomy/emergency） |
| **P22-5 Store+Inventory** | `store-catalog.js`、`inventory.js` | — | `test_p22_store.js`、`test_p22_inventory.js` |
| **P22-6 Exchange** | `exchange.js` + versioned rates | — | `test_p22_exchange.js`（valid/invalid-currency/rate-version/rounding） |
| **P22-7 Compute Credits** | `compute-credits.js` | — | `test_p22_compute_credits.js` |
| **P22-8 Decision/Action Adapter** | `assets/js/economy-adapter.js`（浏览器薄适配，照 `commerce-adapter.js` 形状但**不碰支付**） | ★ `InternalBeyond.html`（`<script>`）、★ `tests/test-all.js` | `test_p22_purchase_orchestrator.js` + 架构回归 |
| **P22-9 Provider/Reasoning Adapter** | `assets/js/economy-compute-budget.js`（**只读** `reasoningCapability`，在 `buildRequestBody` 上游判定） | 可能 ★ `assets/js/communication.js`（**唯一**允许的一行接缝，需单独论证） | `test_p22_compute_budget.js` + `test_middle_brain_reasoning_effort.js` 必须保持全绿 |
| **P22-10 Audit+Recovery** | `economy/audit.js`、`economy/recovery.js` | ★ `http.js`（audit 查询路由） | `test_p22_audit_recovery.js`（崩溃后重建、reservation 过期回收） |
| **P22-11 Minimal UI** | `assets/js/economy-ui.js` + `assets/css/economy.css`（复用 IB 设计语言） | ★ `InternalBeyond.html`（容器 + script + css） | `test_p22_economy_smoke.js`（最小 browser smoke） |
| **P22-12 Closure** | `docs/P22-ECONOMY.md` | ★ `docs/ARCHITECTURE.md`、★ `docs/CHANGELOG.md`、★ `docs/DECISIONS.md` | **一次**完整 static/service 回归 + 现有 canonical 测试全绿 |

**预计总新增文件**：约 20～24 个（其中 Node store 11 个、浏览器契约/适配/UI 4 个、测试 12 个、文档 3 个）。
**预计改动的既有生产文件**：4 个（`home-node-service.js`、`http.js`、`release-manifest.js`、`InternalBeyond.html`），
外加 1 个**需单独论证**的（`communication.js`，仅当 P22-9 无法在缝外完成时）。

---

## 15. 发现的架构风险与迁移风险

### R1 ★★★ Economy → Provider Billing 的写路径必须**结构性不存在**，而不是"约定不写"

**现状**：仓库里确实存在真实付款能力（`bridge/alipay-provider.js` 真的 `spawnSync('alipay-bot', ...)`），
且 `home-node-service.js` 与 Bridge **在同一个 runner 下**被启动
（`runtime/local-services-runner.js`、`runtime/component-registry.js`）。

**风险**：如果 Economy 只是"注释里说不调用支付"，那么 `topUpProvider()` 这类函数
**可以在不违反任何测试的情况下**被写出来。

**建议（P22-1 就要落地）**：把边界写成**可执行谓词 + 结构断言**，照既有 `doesNotExpose`
（`http.js:692`）与 `test_p11_3b G1`（`test_p11_3b_component_registry.js:989-997`，
用正则断言"加载期零 require"）的既有做法：
- Economy 模块**禁止 require** `bridge/*`、`active/payment-*`、`active/credential-vault.js`
  —— 用与 G1 同款的正则/依赖图断言。
- Economy 源码中**禁止出现**标识符 `topUpProvider` / `purchaseRealCredits` / `sendPayment` / `submit_payment`
  —— 用**互相独立的**断言（正向：Economy 的依赖闭包 ⊆ 允许集合；反向：禁用标识符不在词表里）。

### R2 ★★★ 与真实购物共用"预算"这个词

**现状**：`active/commerce.js:572` 已有 `maxBudget`，单位是**元**，通向 `paymentIntent`。

**风险**：P22 的 Budget Policy 若命名成 `budget` 且与 `a.task.maxBudget` 有代码路径交集，
虚拟预算与真实预算会互相污染，且**这个污染在测试里看起来是绿的**。

**建议**：Economy 的余额/预算字段一律带 `IB_CREDIT` / `computeCredit` 单位后缀，
`Purchase Intent` 与 `PaymentIntent` **类型名不同、持久化命名空间不同**
（`ib_economy_*` vs 既有 `payments` map）。并在 P22-12 加一条反例测试：
"Economy 的任意操作都不会改变 `active/commerce.js` 的 `a.task.maxBudget` 或 `paymentIntent`"。

### R3 ★★★ "第三次漏装配" —— Economy store 的两条装配路径

**现状**：`chat` → `memory` → `understanding` → `moments` 各漏过一次
（`home-node-service.js:775-779` 逐字记录了 Moments 那次：
production `openAll()` 从没打开过它，而所有测试都直接 `createMomentsStore()` 因此全绿）。

**风险**：Economy store 会成为**第四次**。症状是 `/economy/*` 返 503/500，
而直接 `createEconomyStore()` 的单元测试**全绿**。

**建议（照既有解法的形状）**：`tests/test_p22_economy_canonical_closure.js`
必须在**真实子进程**上对 `/economy/*` 下断言（同 `test_p11_3e_moments_canonical_closure.js`），
而不是只测 store 本体。

### R4 ★★ 逐文件白名单会让新模块在**安装包**里消失

**现状**：`scripts/release-manifest.js` 是**逐文件白名单，不是 glob**（`:58-61` 逐字说明），
且 `runtime/component-registry.js` 必须**加载期零 require**（`test_p11_3b` G1）。

**风险**：`{ from: 'services/home-node', dir: true }`（`:71`）**不覆盖**新子目录
`services/home-node/economy/`。开发机全绿，安装后启动链直接崩。

**建议**：P22-2 新增 `{ from: 'services/home-node/economy', dir: true, why: ... }`，
并在 P22-12 用"从随包源码扫出跨模块 require 再确认目标在包里"的方式校验
（用户 P11-3X-B 已立此纪律：**不能只核对清单里列出的名字**）。

### R5 ★★ Memory hydrate / envelope 类事故在 Economy 重演

**现状**：用户点名的历史问题有两个可查载体：
- `tests/test_home_node_client_envelope.js`（23.6 KB）
- `tests/test_p11_3f_moments_hydration_safety.js`（67.3 KB）
- 相关根因线索：`assets/js/home-node-bootstrap.js`（63 KB）、
  `assets/js/memory-authority.js:191` 「canonical 模式下的**读**必须在镜像被 Home Node 补齐之前挡住」

**风险**：Economy 若做"浏览器镜像 + Home Node canonical"，
**会**遇到同一类问题：镜像冷启动时读到空余额 → 误判为"余额为 0" →
产生一笔凭空消失/增发的交易。

**建议**：
- Economy 的 `Wallet.cachedBalance` **必须**能区分 `cold` / `degraded` / `ready`
  三态（照 `memory-authority.js:220-222` 的 `readSource()` 形状），
  **禁止**在 `cold` 状态下返回 `0`。
- Ledger 是 canonical，Wallet 是缓存。**任何**写路径都不得以缓存的 balance 为输入来
  计算新余额 —— 必须以 ledger 重放为准，否则缓存漂移会变成真实经济错误。
- 崩溃恢复测试必须覆盖"进程在 RESERVE 与 COMMIT 之间被杀"，并断言
  **总账守恒**（Σ entries == 0 for every transaction）。

### R6 ★★ `DB_VER` 升级会牵动多处硬编码

**现状**：`core.js:3` 与 `chat-core.js:22` 必须同步（`chat-core.js:22` 注释逐字要求），
且 `role-dm.js:63` 记录了"新增 store 会强制升版并牵动多处硬编码"。

**建议**：Economy 的浏览器侧**首选零新 store**（若必须镜像，用单一 store + 内部类型字段），
或者接受一次**显式的、有记录的** DB_VER 23→24 升级，并在 P22-12 逐处核对硬编码。

### R7 ★★ canonical tests 的"全绿"必须真的被跑到

**现状**：`tests/test-all.js` 的 `GROUPS`（`:110-167`）是**显式列表**，
新测试不登记就不会被任何回归执行。

**建议**：P22-12 的架构回归不能用"跑 test-all.js 就行"，必须显式点名
下列既有文件并确认它们在 `GROUPS` 里：
`test_memory_authority.js`、`test_memory_consolidation.js`、`test_memory_contract_closure.js`、
`test_role_dm.js`、`test_middle_brain*.js`（14 个）、`test_reasoning_capability.js`、
`test_p11_3d_tool_execution_guard.js`、`test_home_node_execution.js`、
`test_p11_3e_moments_canonical_closure.js`、`test_p11_3x_c_boundary_mutations.js`。

### R8 ★ 测试预算纪律（用户既有明令）

用户已明确：**不全量重跑 mutation/regression，只复跑失败项；单轮测试 10 分钟硬上限；禁长等待**；
开发期只跑改动相关最小专项测试，完整回归仅在阶段完成与交付报告前各跑一次。
P22 的 12 个阶段必须按此执行，**不得**每阶段跑全量。

---

## 16. 最终回答

> ### 能否在"不破坏 Memory / Relationship / Decision / Action canonical ownership"的条件下实现 P22？
>
> **能。** 理由与前提如下。

**能，因为**：

1. **四个系统的 canonical owner 都已单一化且可只读**：
   Memory = `services/home-node/memory-store.js` + `assets/js/memory-contract.js`
   （`memory-authority.js:53` 的三态客户端已经是唯一入口）；
   Relationship = `assets/js/role-dm-core.js`（契约，含 `RELATION_DELTA_CAP = 0.03`）
   + `role-dm.js`（唯一写入点 `relationSave`）；
   Decision = `active-plans.js` 的 `intent` + `active/commerce.js` 的 intent 状态机；
   Action = 工具回合（`integrations.js` `IBMCP.execOp`）+ `tool-execution-guard.js`
   + Middle Brain（`middle-brain.js` `middleBrainExecute`）+ `execution.js`。
   Economy 只需要**读**它们并**经它们**写。

2. **接入点是增量式的**：`home-node-service.js` 的 `economyAssembly()` + 三处装配
   （`open()`/`close()`/`openAll()`）、`http.js` 的 `/economy/*` + `economyPolicy`、
   `release-manifest.js` 一条目录登记、`InternalBeyond.html` 一个 `<script>`。
   **零既有业务逻辑改动。**

3. **既有机制可以直接复用而不是重造**：
   append-only + revision + change_log（`memory-store.js:12-13`、`:55`）是 Ledger 的现成模板；
   `idempotency` 表（`chat-store.js:140`）是交易幂等的现成模板；
   `characters` / `character_runtime_specs` **分表**（`device-registry.js:592-597`）
   是"Economy 看不到 API Key"的现成机制；
   `doesNotExpose`（`http.js:692`）是硬边界的现成写法。

4. **Economy 不需要新增任何"第二个"东西**：
   不需要第二个 Provider Router（`ib-model-core.js` 已唯一）、
   不需要第二份 provider metadata（`provider-directory.js` 已唯一，用户 P4 已冻结）、
   不需要第二个 Middle Brain（`middle-brain.js` 已唯一）、
   不需要第二个 action executor（工具回合已唯一）、
   不需要第二份角色表（`apiConfigs` 已唯一，用户 P4 已冻结）、
   不需要第二份 reasoning 能力表（`provider-directory.js:246-248` 已声明"唯一一份"）。

**但必须满足 5 个前提**（缺一不可）：

| # | 前提 | 落点 |
|---|---|---|
| **A** | Economy → Provider Billing 的写路径**结构性不存在**（依赖闭包断言 + 禁用标识符断言），不是注释约定 | P22-1，见 §15 R1 |
| **B** | Economy 只产 **event**，不写 Memory / 不改 affection/trust；是否成记忆/是否变关系由既有系统决定 | P22-5 / P22-8，见 §3 / §2 |
| **C** | Budget Policy 是**确定性纯函数**，LLM 输出**不能**作为其输入的一部分；单位与真实货币命名空间隔离 | P22-4，见 §15 R2 |
| **D** | Economy store **同时**进 `buildHomeNode().open()/close()` 与 `openAll()`，且由**真实子进程**断言锁定 | P22-2，见 §15 R3 |
| **E** | 每个 store 自带 schema 版本与 revision 命名空间，**不共用** chat/memory 的；迁移幂等且不清库 | P22-2 / P22-10，见 §9.2 / §9.3 |

**P22-0 到此为止。** 等确认后再进入 P22-1 Economy Contract。
