# P26-2 · Observation Contract

状态：**FOUNDATION / CONTRACT / PURE CORE / AUDIT-FIRST / NO PRODUCTION INTEGRATION**。
建立 `assets/js/observation-core.js`。
**Production observers = 0**：Cinema / Co-read / Voice / Presence / Timeline / Frame / Vision /
Memory retrieval / Activity runtime 全部零接线、零改动。

---

## 1. Why Observation exists

P26-0 的 Gap #2：仓库里的"只读观察"（Cinema 留影帧、播放进度、字幕、activity context、
chat context、运行时状态投影）散落在三处 —— **请求内参数**、**域字段**、**投影函数**，
没有统一契约说明"这是什么、多新、来自谁、现在可不可用"。
Observation Contract 就是那一层**只读契约**：它**不**取代任何观察生产者，
只是让"现在是什么"有一个最小、可验证、可序列化的表达。

## 2. Definition

> **Observation = 某个 source 在某个时间点，对某个 domain/entity 当前状态的、可验证的描述。**

它是**读取结果的描述**，不是状态本身、不是事件、不是动作、不是意图、不是命令、不是能力。

## 3. Event vs Observation（冻结）

| | Event（P26-1） | Observation（本阶段） |
| --- | --- | --- |
| 回答 | **发生了什么** | **现在是什么** |
| 时间方向 | past fact | current snapshot |
| canonical? | 否 | 否 |
| 是否可重建 | 通常按 id 查 canonical 行 | 通常直接读取（或由域字段投影） |
| 是否触发行为 | 否 | 否 |
| 是否拥有状态 | 否 | 否 |
| 必备字段 | entityId / timestamp / **type** | entityId / observedAt / **source / freshness / availability** |

**冻结**：`EVENT_RECEIVED != OBSERVATION_AVAILABLE`、`OBSERVATION_AVAILABLE != AGENT_WAKE`。

## 4. Minimal Shape

```
{
  observationId,   // REQUIRED  稳定身份（注入或确定性派生）
  domain,          // REQUIRED  域标识（token）
  entityId,        // REQUIRED  被观察的实体（canonical id / 活动 id / 会话 id）
  source,          // REQUIRED  谁提供这个观察（点分标识，例如 cinema.player）
  observedAt,      // REQUIRED  观察时刻（number，注入；core 不读时钟）
  freshness,       // REQUIRED  'fresh' | 'stale' | 'unknown'（producer 的声明）
  availability,    // REQUIRED  'available' | 'unavailable' | 'unknown'
  valueRef?,       // OPTIONAL  状态**位置引用**（例如 activities.progress#sec）
  version          // 由 core 固定写入 'observation/v1'
}
```

**没有** `value` / `snapshot` / `payload` / `data` / `content` / `state` / `record` 等自由槽：
未知字段与状态正文字段一律**拒绝**（不是静默丢弃）。

## 5. Identity

- `observationId` 优先由调用方注入（`options.observationId`）；
- 未注入时由 `chat-core.stableToken` 对 `domain|entityId|source|observedAt|valueRef` **确定性派生**（`obs_…`）；
- 同一 source 对同一实体在同一时刻重复观察 ⇒ 同一 id（consumer 可据此去重）；
- **不引入**持久 id 分配器 / 全局序列 / 计数器；**不读时钟**（`Date.now` 不存在）、**不用随机**（`Math.random` 不存在）。

## 6. Source

`source` = **谁提供这个观察**（生产者身份），例如 `cinema.player` / `voice.runtime` / `presence.service`。

- **与 Domain Event 的 `origin` 不是同一层**（event origin 描述因果链来源）；
- **与 capability 的 `source` 不是同一层**（后者是"谁发起的动作"，属于 P25 各域闭集）；
- Core **不持有任何 source 词汇表**（只校验语法：点分小写 token）；未来新增观察生产者无需改 core。

## 7. Freshness

**裁决：`freshness` REQUIRED**，闭集 `['fresh','stale','unknown']`。

理由：观察与事件最大的区别就是"新鲜度" —— 一个没有新鲜度的观察无法被解释
（"这是现在的位置还是三分钟前的位置？"）。`unknown` 允许那些**无法判断**的 source 诚实表达，
而不是被迫声称 fresh。

Core **不自动刷新**、**不轮询**、**不读时钟**。除了 producer 的声明，core 还提供纯函数
`freshnessOf(observation, { now, maxAgeMs })` 供消费者用**注入的时间**判断：

| 输入 | 结果 |
| --- | --- |
| `now` 或 `observedAt` 缺失/非法 | `'unknown'` |
| `now < observedAt` | `'unknown'`（时间倒流不当成 fresh） |
| 无 `maxAgeMs` | `'fresh'` |
| `now - observedAt > maxAgeMs` | `'stale'` |
| 其它 | `'fresh'` |

**声明 vs 派生是两件事**：producer 声明 `freshness:'stale'` 而消费者在 1ms 后计算可能得到 `'fresh'` ——
contract 只规定两者的语义，不规定谁优先（不引入自动刷新）。

## 8. Availability

**裁决：`availability` REQUIRED**，闭集 `['available','unavailable','unknown']`。

`unavailable` **不**触发 fallback action、**不**把观察失败变成业务失败：
它只是"这个 source 现在拿不到"的诚实表达（例如玩家未加载、字幕未上传）。

## 9. Confidence decision

**裁决：P26-2 不加入 `confidence`。**

理由（代码事实）：今天真实的观察源都是**确定性**的 ——
Cinema 进度/字幕（精确值）、Co-read 页（精确值）、frame（一次性画面）、activity context（投影）。
没有任何生产者需要概率/置信度；P26-0 也明确规定**不得发明**情绪分数之类的分数。
若未来出现真实的概率型观察（例如视觉检测、情绪估计），应作为**显式扩展**单独论证
（范围 0–1、语义、是否 core 验证），而不是先放进最小契约。

## 10. Payload boundary

**禁止** Observation 变成第二 canonical record：

```
❌ { observation:{ …full activity object… } }
❌ { frameBase64:'…', subtitleText:'…', fullActivity:{…} }
❌ { value:{…} } / { snapshot:{…} } / { payload:{…} }
✅ { …, valueRef:'activities.progress#sec' }        // 位置引用
✅ { …, valueRef:'frame://act_1/last' }             // 资源引用
```

主对象是 state、frame、buffer、音频、聊天全文、Memory 全量内容时，
必须走 **resource reference**（`valueRef`），不属于 observation core。

## 11. Canonical boundary

Core **不写**任何 canonical store（`chatMessages` / `moments` / `diary_entries` / `roleLetters` /
`activities` / `memories`）。Canonical Writer **不变**：观察只是读取结果的描述。

## 12. Authority boundary

Observation **不经过** Authority：`Observation → Permission`、`Observation → Execute`、
`Observation → Capability` 三条边都不存在。读取本身的权限边界（如 Memory 可见性、
Moments 可见性核）属于**各域既有实现**，本阶段不改造。

## 13. Executor boundary

Core **不执行**任何动作（不 `createMoment` / `writeDiary` / `sendMessage` / `writeLetter` /
`createActivity`），也不引用任何 executor。

## 14. Agent wake boundary

**`OBSERVATION_AVAILABLE ≠ AGENT_WAKE`**（硬冻结）。未来若需要：
`Observation → Feedback Policy → Wake Eligibility → Planner`，
每一步都必须显式定义；本阶段**不实现**，Core 里也不存在 wake/trigger 语义。

## 15. Persistence

Core **不持久化**：零 IndexedDB / localStorage / SQLite / 文件 / event store。
**Observation cache 不属于本阶段**（是否缓存是未来域策略）。

## 16. Subscription

**禁止**实现 `subscribe()` / `unsubscribe()` / observer manager / watcher registry：
`Observation Contract != Observation Transport`。消费者今天通过**拉取**（读取域字段/投影函数）
获得观察；未来若要推送，那是显式的新能力（本阶段不做）。

## 17. Runtime neutrality

Core 是 **runtime-neutral**（纯数据 + 纯函数，Node 与浏览器都能 require —— 测试即在 Node 直接 require），
且**不触碰**任何运行时 API：零 browser API / DOM / WebSocket / fetch / IPC。

## 18. Session boundary

观察**可以**在未来关联 session，但 Core **不拥有** session：不引入 `sessionId` 字段、
不创建 Session Manager、不定义会话生命周期（P26-3 处理）。

## 19. Resource boundary

观察**不负责**资源锁 / 租约 / 优先级 / 仲裁（P26-4 处理）。
`availability:'unavailable'` 只是事实描述，不是"抢资源"的请求。

## 20. Examples（EXAMPLE ONLY —— 生产 observers = 0）

```
// Cinema 播放进度（位置引用；不携带秒数正文）
{ observationId:'obs_…', domain:'cinema', entityId:'act_…', source:'cinema.player',
  observedAt:1770000000000, freshness:'fresh', availability:'available', valueRef:'activities.progress#sec' }

// Cinema 留影帧（可用性 + 资源引用；**不**携带 base64）
{ observationId:'obs_…', domain:'cinema', entityId:'act_…', source:'cinema.player.frame',
  observedAt:1770000000000, freshness:'fresh', availability:'available', valueRef:'frame://act_…/last' }

// Co-read 页位置
{ observationId:'obs_…', domain:'coread', entityId:'act_…', source:'coread.reader',
  observedAt:1770000000000, freshness:'fresh', availability:'available', valueRef:'activities.progress#page' }

// Voice 运行时状态（source 属于 voice runtime，**不是** Authority）
{ observationId:'obs_…', domain:'voice', entityId:'call_…', source:'voice.runtime',
  observedAt:1770000000000, freshness:'fresh', availability:'available' }

// source 当前不可用（诚实表达，不触发 fallback）
{ observationId:'obs_…', domain:'cinema', entityId:'act_…', source:'cinema.player.subtitle',
  observedAt:1770000000000, freshness:'unknown', availability:'unavailable' }
```

创建方式（纯函数）：

```js
IBObservationCore.createObservation(
  { domain:'cinema', entityId:'act_1', source:'cinema.player', freshness:'fresh', availability:'available' },
  { observedAt: 1770000000000 }        // 时间与身份都可注入 ⇒ 测试完全确定性
);
```

## 21. Non-goals

本阶段**不**实现：Observation Bus · Observer Registry · Subscription System · Realtime Stream ·
Frame / Vision / Voice Pipeline · Observation Store / Cache · Session Runtime ·
Resource Arbitration · Agent Wake · Feedback Loop；**不**接入任何真实 observer；
**不**修改 Cinema / Co-read / Voice / Presence / Timeline / Moments / Memory / Activity 运行时，
也**不**修改 P23 / P24 / P25 foundation 与任何域生产代码；**不**新增 store / DB migration。

---

## 附：Existing Observation Audit（Phase 0，只读分类）

| 观察源 | 分类 | 今天的实现 | 是否进 Observation Contract？ |
| --- | --- | --- | --- |
| Cinema 留影帧 | **External Resource Observation** | `grabFrame()` → request-local `visionReference`（不落库） | YES（作为 `source:'cinema.player.frame'` + `valueRef:'frame://…'`），**不**携带像素 |
| Cinema 播放进度 | External Resource + Derived | `activities.progress.sec/dur/pct`（1.5s 节流写回） | YES（`valueRef:'activities.progress#sec'`） |
| Cinema 字幕切片 | External Resource Observation | 本地 `.srt` 解析 → `activities.progress.subs` | YES（位置引用；**不**携带字幕文本） |
| Co-read 页 / 梗概 / 书签 | Canonical State + Derived（进度派生） | `activities.progress` / `bookmarks` | YES（页位置）；梗概属 Derived（可引用） |
| Voice 运行时状态 | **Runtime Observation** | `communication/voice.js` 的内部状态（通话/播放） | YES（`source:'voice.runtime'`）；音频数据本身**不**进契约 |
| Presence | **NOT PRESENT**（Activity 域） | 仅 Mobile Gateway 的 `presence.changed`（传输层） | 将来若是 Activity presence 再评估；今天不接 |
| Timeline / Moments view | **Canonical State Observation** | 直接读 `moments` store + 可见性核 | 属 canonical 读取（已有），**不**需要 observation core |
| Activity state | Canonical + Derived Projection | `activities` 记录 + `resolveActivity` + `buildActivityContext` | 属域运行时字段/投影（已有）；如需统一描述可用 observation core（未来） |
| Memory retrieval | **Canonical State Observation**（有读取权限边界） | `memories` + `isMemoryVisibleTo` | **不**进 observation core（权限边界属 Memory 域，本阶段不改造） |
| Mobile Gateway sync | **Transport**（事件不含正文，状态靠 pull） | 事件频道 + `sync.changes` | 不属 observation core（传输层） |
| P23 delivery state | **Runtime state**（队列 queued→delivering→…） | `delivery-runtime.js` 内存队列 | 不属 observation core（交付域运行时） |

**不强行统一**：以上只有前三类（External Resource / Runtime /部分 Derived）适合用本契约描述；
Canonical State 读取、Transport、Delivery 运行时各自已有归属。
