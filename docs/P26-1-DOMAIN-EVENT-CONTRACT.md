# P26-1 · Domain Event Contract

状态：**FOUNDATION / CONTRACT / PURE CORE / TEST-FIRST**。
本阶段只建立 **Domain Event Contract Foundation**（`assets/js/domain-event-core.js`）。
**Production emitters = 0**：没有任何真实 domain 接线（Moments / Diary / Active Message /
Role Letter / Activity / Cinema / Co-read 全部零改动）。

---

## 1. Why Domain Events exist

P25 解决了"想做什么 → 允许 → 执行 → canonical effect → verify"，
但 effect **发生之后**没有任何统一表达"发生了什么"的方式（P26-0 Gap #1）：
各域只有 canonical 行、UI 局部回调、或单域自有事件队列。Domain Event 就是那个最小表达：
**一个已经发生的域事实**。它不是总线、不是交付、不是观察（见 §3）。

## 2. What is a Domain Event

> **Domain Event = "某个域里一件已经发生的事实"的最小、可验证、可序列化的描述。**

它回答"**发生了什么**"，而不是"现在是什么"（后者是 Observation）。
它的典型生命周期：canonical writer 成功 → 域产生事件 → （未来）消费者按需读取
canonical state 补齐内容。事件本身**不携带**业务正文。

## 3. What is NOT a Domain Event

| 不是 | 为什么 |
| --- | --- |
| Event Bus | 事件是**事实描述**，不是订阅/路由/投递机制（本阶段不实现总线） |
| Transport Message | 跨进程投递属传输层（Active companion 的 HTTP 轮询、Mobile Gateway 通知） |
| UI Event | typing / 小窗刷新是 UI 表现（`IBApps.broadcast`） |
| DOM Event | 浏览器事件（online / visibilitychange）与域事实无关 |
| Callback | `IB.activity.on/off/_emit` 是内存回调（无持久化、无 identity 语义） |
| Observation | "现在是什么"（frame / progress / subtitle / context 投影） |
| Agent Trigger | 事件**不唤醒** agent（见 §22） |
| Canonical Record | 事件不复制 canonical 行（见 §9） |
| Audit Log | 事件不是审计日志（无持久化要求，见 §14） |
| Queue Item | 事件不进交付队列（P23 的职责） |
| Notification | 通知是投递行为（`windowsNotify` / Mobile 事件频道） |

## 4. Minimal Shape

```
{
  eventId,        // REQUIRED  稳定身份（注入或确定性派生）
  domain,         // REQUIRED  域标识（token，例如 'moment'）
  type,           // REQUIRED  该域里的事实动作（token，例如 'created'）
  entityId,       // REQUIRED  指向 canonical 行的实体身份
  timestamp,      // REQUIRED  事实发生时间（number，由调用方注入）
  actorId?,       // OPTIONAL  谁触发的（canonical role id）
  origin?,        // OPTIONAL  因果链的来源标识（**独立于** capability 的 source enum）
  causationId?,   // OPTIONAL  直接原因（见 §9 裁决）
  correlationId?, // OPTIONAL  同一条因果链
  version         // 由 core 固定写入 'domain-event/v1'
}
```

**没有** `metadata` / `payload` / `content` / `body` 之类的自由槽（§12 逃生舱禁令）：
未知字段与业务正文字段一律**拒绝**，不是静默丢弃。

## 5. Identity

- `eventId` 优先由调用方注入（`options.eventId`）；
- 未注入时由 core **确定性**派生：`'evt_' + stableToken(domain|type|entityId|timestamp|
  causationId|correlationId|actorId|origin)`（复用 `chat-core.stableToken`）；
- **不引入**持久 id 分配器 / 全局序列 / 数据库计数器；
- **不读时钟、不用随机**：`Date.now()` / `Math.random()` 在代码里不存在（E10/E11 守卫）；
- 同一事实重复创建得到同一 `eventId` ⇒ 消费者可以据此去重（§12 Consumer Idempotency）。

## 6. Domain / Event Type

裁决：采用 **A —— `domain` + `type` 两个字段**（单一词表持有者）：

```
domain: 'moment'   type: 'created'          → 语义 = moment.created
```

理由：

1. 若同时维护 `eventType:'moment.created'` 与 `domain`/`type`，就有**两份 authority** 表达同一件事；
2. 域的**词表归属**天然落在 `domain` 上（`type` 是该域下的事实动作），P26-0 已确立"域内版本化 source"的原则；
3. 便利性由**输入别名**解决：允许在**输入**里写 `eventType:'moment.created'`（core 拆分为 domain+type，
   并要求与显式 `domain` 一致，否则 `event-type-domain-mismatch`）；
   例如 `{ domain:'diary', eventType:'diary.written' }` 与 `{ domain:'diary', type:'written' }` 等价，
   而 `{ domain:'moment', eventType:'diary.written' }` 被拒绝；
4. `describeEvent` 仍会给出便于日志的 `eventType: 'moment.created'` 字符串（**派生视图**，不是存储字段）。

`type` 必须是 token（`^[a-z][a-z0-9_]*$`）；Core **不**持有任何 domain/type 词表（§23 可扩展性）。

## 7. Entity Identity

`entityId` 指向**该域的 canonical 行**（`moment_*` / `diary_*` / `rletter_*` / `active_msg_*` / `act_*` …）。
事件**只**引用它，不复制它。若消费者需要内容，必须自己按 `entityId` 从域 canonical 源读取。

## 8. Timestamp

- 必须是 number（毫秒）且 > 0；
- 只能由调用方注入（`input.timestamp` 或 `options.timestamp`）；
- Core **不读时钟**（E10）：`missing-timestamp` 是显式错误，而不是"拿现在补上"。

## 9. Causation（裁决）

P26-0 留下开放问题：causationId 是**字段级 REQUIRED**（A）还是**只在可再触发路径 REQUIRED**（B）？

**裁决：B。**

| 情况 | 要求 |
| --- | --- |
| 普通 post-effect 事实事件（本阶段主模型） | `causationId` **OPTIONAL**（`canonical write → event`，没有"原因事件"） |
| 该事件**允许再次触发行为**（未来 feedback policy → action → canonical write → event） | `causationId` **REQUIRED**，由调用方以 `options.requireCausation: true` 声明（缺失 ⇒ `causation-required`） |

理由：本阶段只有"post-effect fact event"（不变量 15），此刻把 causationId 强制为必填会
迫使每个 producer 编造一个"原因"（虚假因果比缺失因果更糟）；而一旦存在"事件→行为"的路径，
因果必须可追溯（防环的最低要求）。裁决记录在 `createDomainEvent(input, {requireCausation})`。

## 10. Correlation

`correlationId` **OPTIONAL**：用于把跨域/同域的多个事实串成一条因果链
（例如"用户一次动作 → 多个域 effect"）。它**不**参与 ordering（§13）、**不**参与权限、
**不**进任何全局 trace store（§47）：Core 只把它当契约数据。

## 11. Producer Contract

Producer（未来各域的 canonical writer 之后的调用点）**MUST**：

1. **只在事实已经成立之后**创建事件（writer 成功 → event；**绝不** event → writer）；
2. 提供 `domain`/`type`/`entityId`/`timestamp`（时间由自己注入，不指望 core 读时钟）；
3. 在"事件可再触发行为"的路径上提供 `causationId`；
4. 不把业务正文塞进事件（被拒绝），不把凭据塞进事件（被拒绝）；
5. 把事件创建失败视为**下游问题**（见 §25 失败语义）——**不得**回滚 canonical effect。

## 12. Consumer Contract

Consumer（未来）**最小语义**：

1. `receive / read` 事件；
2. `validateDomainEvent(event)` 校验；
3. **可选**按 `entityId` 读取 canonical state 补齐内容；
4. 想执行动作 / 唤醒 agent / 写 canonical state ⇒ 必须有**显式 policy**（不在本阶段定义）。

Consumer **不得**因为收到事件就默认动作（不变量 10/11/12）。Core **不提供**订阅总线，
也**不提供**持久去重表 —— 只规定 `eventId` 可作为 dedupe key（`dedupeKeyFor`）。

## 13. Ordering

- **没有**全局序、**没有** sequence number、**不比较跨 domain 的 timestamp**；
- Core 只提供 `orderingKeyFor(event, scope)`：

| scope | 结果 | 用途 |
| --- | --- | --- |
| `entity`（默认） | `domain + ':' + entityId` | 同一实体的多个事实可排序 |
| `domain` | `domain` | 只保证"同域可比较" |
| 其它（含 `session` / `turn` / `global`） | `''`（拒绝） | session 契约属 P26-3；全局序无证据 |

P23 的 `sequenceIndex` 与 P24 的 `groupOrder` **不**被复用为事件 ordering（各自域的身份）。

## 14. Persistence Boundary

Core **不持久化**：零 IndexedDB / localStorage / 文件 / Home Node / SQLite / event log。
是否持久化是**域策略**（今天只有 Active Message 的交付事件持久，且那是它自己的域实现）。

## 15. Replay Boundary

Core **不实现 replay**。IB 当前**不是** event-sourced 架构：
消费者应优先按 canonical state 重建（指针可重建、行可读回）。

## 16. ACK Boundary

Core **不实现 ACK**。Active Message 的 ACK 属它的域/传输；Mobile Gateway 的订阅 ACK 属传输。
两者**不得**被提升为"所有 Domain Event 的强制契约"。

## 17. Cross-runtime Boundary

Core 是 **runtime-neutral**（纯数据 + 纯函数，可被任意运行时 require），但**不实现**任何传输：
HTTP / WebSocket / 轮询 / postMessage / IPC 全部不在范围内。事件对象**可**被未来传输携带 —— 
"可以被传输"不等于"已经跨进程"。

## 18. Observation Boundary

Domain Event："发生了什么"；Observation："现在是什么"。
Core **不注册** 观察生产者、**不读取** frame / progress / subtitle / state。
（Observation Contract 属 P26-2。）

## 19. Authority Boundary

Core **不做** permission decision，也**不引用**任何域权威
（Moments Mutation / Autonomy Core / Diary / Active Message / Role Letter）——
事件是 effect 的**下游事实**，本身不需要"被允许"。守卫 E29 钉住这一点。

## 20. Executor Boundary

Core **不执行**任何 domain action（不 `createMoment` / `writeDiary` / `sendMessage` /
`writeLetter` / `createActivity`）。守卫 E30。

## 21. Canonical Writer Boundary

Core **不写**任何 canonical store（`chatMessages` / `moments` / `diary_entries` /
`roleLetters` / `activities` / `memories`）。它**不能**成为第二 writer：只能描述已发生的 effect。
守卫 E31。

## 22. Agent Wake Boundary

**`EVENT_RECEIVED` ≠ `AGENT_WAKE` ≠ `AUTONOMOUS_ACTION` ≠ `CAPABILITY_EXECUTION`。**
Core 不包含 wake / trigger / notify 语义（守卫 E34）。未来若需要：
`Event → Feedback Policy → Agent Wake Eligibility → Planner` —— 每一步都必须有显式 policy，
且**不在本阶段**。

## 23. Serialization

事件必须 **JSON-serializable**：拒绝 function / symbol / undefined / bigint / DOM 节点 /
Blob / File / AbortSignal / Error / Promise / class 实例 / 循环引用（深度上限 4）。
原因：未来可能被传输；但本阶段**不**实现传输。

## 24. Secret Safety

- 复用仓库既有的纯探针 `voice-message-core.findSecret`（不做第二套 DLP）；
- 命中凭据形态（如 `sk-…` / `bearer …`）或凭据键名 ⇒ `secret-in-event`；
- 事件字段闭集本身也排除了 `apiKey` / `authorization` / `cookie` / `token` 之类的落点。

## 25. Failure Semantics

| Situation | Canonical effect | Event | Overall business result |
| --- | --- | --- | --- |
| writer fails | 未产生 | 不应创建（producer 只在事实成立后创建） | **业务失败**（既有失败语义不变） |
| writer succeeds / event creation succeeds | 已产生 | 创建成功 | **业务成功** |
| writer succeeds / event creation fails | **已产生（不回滚）** | 创建失败（`{ok:false, errors}`） | **业务成功**；事件缺失按域策略处理（报告/追踪/忽略），**不**重试（本阶段不实现 retry） |
| consumer fails | 不受影响 | 已创建 | **业务成功**；消费失败由消费者自己的 policy 处理 |
| consumer unavailable | 不受影响 | 已创建（若域选择不持久，则丢弃） | **业务成功** |

**核心原则**：`writer success` **不能**因为 downstream event 失败而变成业务失败。

## 26. Examples（EXAMPLE ONLY —— 生产 emitters = 0）

```
// Moment（示例）
{ eventId:'evt_…', domain:'moment', type:'created', entityId:'moment_…', timestamp:1770000000000 }

// Diary（示例）
{ eventId:'evt_…', domain:'diary', type:'written', entityId:'diary_…', timestamp:1770000000000, actorId:'role_a' }

// Active Message（示例；注意它今天已有自己的域事件队列，本阶段**不**接线）
{ eventId:'evt_…', domain:'active_message', type:'sent', entityId:'active_msg_…', timestamp:1770000000000,
  actorId:'role_a', origin:'companion', causationId:'evt_plan_…' }

// Role Letter（示例）
{ eventId:'evt_…', domain:'role_letter', type:'written', entityId:'rletter_…', timestamp:1770000000000,
  actorId:'role_a', correlationId:'corr_letter_…' }

// Activity lifecycle（未来示例；今天 `finished` 连写入者都不存在）
{ eventId:'evt_…', domain:'activity', type:'started', entityId:'act_…', timestamp:1770000000000, actorId:'role_a' }
```

创建方式（纯函数）：

```js
IBDomainEventCore.createDomainEvent(
  { domain:'diary', type:'written', entityId:'diary_1' },
  { timestamp: 1770000000000, actorId: 'role_a' }   // 时间与身份都可注入 ⇒ 测试完全确定性
);
```

## 27. Non-goals

本阶段**不**实现：Event Bus / Event Store / Event Router / Subscription Manager /
Observation Layer / Session Manager / Resource Arbitration / Feedback Loop / Agent Wake /
跨运行时传输 / 全局序 / 通用 ACK 或 replay；**不**扩张全局 source 或 decision enum；
**不**注册任何 capability；**不**修改 P23 / P24 / P25 foundation 与任何域生产代码。

## 28. Deferred Integration

| 未来阶段 | 内容 |
| --- | --- |
| 域接线（P26-1 之后） | 各域 canonical writer 成功后创建事件（**每个域单独一次接线**，先报告再改） |
| P26-2 | Observation Contract（producer 登记 / 只读契约 / 投影 / 新鲜度） |
| P26-3 | Session Runtime Contract（session 身份、状态归属、最小生命周期） |
| P26-4 | Resource Arbitration 归属契约 |
| 更后 | 域事件持久化 / replay / ACK / 跨运行时传输 / feedback policy / agent wake（按域决定） |

## 附：边界矩阵（Core owns?）

| Concern | Domain Event Core owns? |
| --- | --- |
| identity | **YES** |
| validation | **YES** |
| ordering key | **YES（最小）** |
| canonical data | NO |
| permission | NO |
| execution | NO |
| persistence | NO |
| replay | NO |
| ACK | NO |
| routing | NO |
| subscription | NO |
| transport | NO |
| observation | NO |
| agent wake | NO |
| feedback policy | NO |
| session ownership | NO |
| resource arbitration | NO |

## 附：Integration Readiness Matrix（未来，不代表本阶段接线）

| Domain | Candidate Event | Canonical Writer Known? | Integration Ready? | Blocker |
| --- | --- | --- | --- | --- |
| Moments | `moment.created` | 是（`_momentsWriteCanonical`） | READY（契约层） | 需先定义"哪个 create 路径算事实"（自主 / 手动 / companion） |
| Diary | `diary.written` | 是（`_diaryWriteCanonical`） | READY（契约层） | 需确认 memory 链接写是否也算一次事实 |
| Active Message | `active_message.sent` | 是（浏览器 `_activeWriteCanonical` + Node 事件队列） | **PARTIAL** | 已有自己的域事件队列与 ACK ⇒ 需先决定是否统一（本阶段不动） |
| Role Letter | `role_letter.written` | 是（`_rlWriteCanonical`） | READY（契约层） | reply 与 init 的 `type` 词表待定（`written` vs `written.reply`） |
| Activity | `activity.started` / `progressed` / `finished` | 部分（`createActivity` 是唯一创建写点；`finished` 无写入者） | **NOT READY** | 生命周期本身不存在（P26-3 先落 Session Runtime Contract） |

## 附：Event vs Existing Mechanisms

| 机制 | semantic meaning | canonical? | persistent? | cross-runtime? | ACK? | ordering? | business body? | consumer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Domain Event（本阶段契约）** | 已发生的域事实 | NO | 由域策略（默认 NO） | 不假设 | 由域/传输策略 | per-domain / per-entity | **禁止** | 未来按域订阅 |
| Activity callback（`on/off/_emit`） | 内存回调 | NO | NO | NO | NO | 注册顺序 | 可携带任意对象 | 同页订阅者 |
| `IBApps.broadcast` | UI/传输广播 | NO | NO | NO | NO | 注册顺序 | 可携带任意对象 | 当前打开的 App |
| DOM Event | 浏览器事件 | NO | NO | NO | NO | 浏览器保证 | 任意 | 页面监听器 |
| Active persisted event | 交付结果（单域） | NO（canonical 在 chatMessages） | YES | YES（HTTP 轮询） | YES | 轮询顺序 | 含正文（它自己的交付记录） | 浏览器消费者 |
| Mobile Gateway notification | 传输层通知 | NO | 由传输层 | YES | 订阅级 | 频道顺序 | **不含正文**（状态靠 pull） | 移动端设备 |
| P23 delivery unit | 待交付的消息单元 | 落 chatMessages | NO（队列 runtime-only） | NO | turn end 广播 | `sequenceIndex` | 是（消息内容） | 会话流 / UI |
