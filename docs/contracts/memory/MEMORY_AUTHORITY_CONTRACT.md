# Memory Authority Contract

**Status: Canonical**
**Scope: Memory storage authority、mirror policy 与 write invariants**

> 当前状态 contract。它固定谁拥有 durable memory state、browser mirror 与其如何关联，以及保持二者一致的
> write ordering。它不描述 retrieval scoring
>（见 [`../../architecture/MEMORY.md`](../../architecture/MEMORY.md)）或 record shape
>（见 [`MEMORY_RECORD_CONTRACT.md`](MEMORY_RECORD_CONTRACT.md)）。

---

## 1. Authority

```
Home Node  = canonical      (services/home-node/memory-store.js)
Browser    = mirror         (IndexedDB store `memories`)
Mobile     = denied         (no memory verb, no cache)
```

- Canonical durable state 是 Home Node `memory_records`（外加 `memory_change_log` 与 `memory.*` meta）。
- browser IndexedDB `memories` store 是一个 **mirror / migration source / rollback shadow**。
- Mobile 没有 memory authority、没有 memory sync，也没有 memory cache。

Evidence：`assets/js/memory-authority.js`；`assets/js/home-node-bootstrap.js`（memory authority assembly）；
`docs/HOME_NODE_CHAT.md §15`；`services/home-node/http.js` `memoryPolicy`；`services/home-node/mobile-gateway.js`。

---

## 2. 写入不变量（canonical mode）

```
write request
   │
   ▼
Home Node write (POST /memory/records)
   │
   ├─ success ─► apply to browser mirror
   │
   └─ failure ─► NO mirror-only write; fail closed
```

- canonical write 会**先**发往 Home Node。
- 只有在 canonical write 成功之后，mirror 才会被更新。
- 在 canonical mode 下 Home Node 失败时，写入会 **fail closed**；它**绝不会**被仅记录到
  mirror 而当作 canonical 处理。

Evidence：`assets/js/memory-authority.js`（put path；`authority:'home-node'` vs `mirrorOnly:true`）；
`home-node-bootstrap.js` 的 memory authority notes。

### 2.1 Activation authority（`ACTIVATION_AUTHORITY_OPTION = A` · R2-H1 冻结）

> **Decision（2026-10-02 · R2-H1 冻结 · R2-H2 实现 · R2-H3 语义收口 · R2-H4 收口）
> —— `R2-H ACTIVATION AUTHORITY = CLOSED`。**
> **在 canonical mode 下，Home Node 是 activation telemetry 的唯一 canonical durable authority。**
> Browser IndexedDB 的 `activationCount` / `lastActivated` 是 **mirror / cache state**，
> **不是**可以与 Home Node 分叉的独立 durable authority。
> 最终矩阵见 **§2.7**（唯一权威表）；实现状态：已接线（`assets/js/memory.js` → `memoryAuthority.recordActivation`）。

| 事实 | 冻结内容 |
|---|---|
| canonical durable truth | Home Node `memory_records.activation_count` / `last_activated_at`（**唯一**） |
| browser `activationCount` / `lastActivated` | mirror / cache；只能反映 canonical 值，不得成为权威 |
| 单写者（canonical mode） | Home Node activation writer（`memory-store.js` `recordActivation`） |
| browser recall activation 的顺序 | **remote-first**：canonical activation request **成功后**，mirror 才允许反映该次 activation |

**MUST**：canonical mode 下，browser recall 的 activation **不得**先写 mirror 再 best-effort 发远端。
"先本地乐观 +1，再尽力远端"这一形状**被禁止**。

**MUST NOT**：不得让 browser 持有"未经 Home Node 确认"的 activation truth。

**范围限定**：remote-first 只约束 **activation telemetry authority**。
它**不**改变 conversation / recall 的结果语义 —— 见 §2.3。

### 2.2 Activation success（canonical mode）

canonical activation **成功**后：

- Home Node `activation_count` 增加、`last_activated_at` 更新；
- browser mirror **可以**更新为与该 canonical 值一致的缓存值；
- mirror 仍是 mirror —— 它不因"被更新过"而取得权威。

**本 contract 不冻结**成功响应的形状（是否回传 canonical telemetry）——
那是实现在 R2-H2 的自由度。

### 2.3 Activation failure（canonical mode）

activation 写入失败**必须**先区分两类结局 —— 二者不可混为一谈：

```
DEFINITE_FAILURE     服务端**明确**回了失败（它是唯一的写者，因此它没有 commit）
                     ⇒ canonical 不增加 且 browser mirror 也不增加
AMBIGUOUS_OUTCOME    transport 层失败（reset / timeout / throw）：服务端**可能已经 commit**
                     ⇒ canonical 的最终状态对 caller **未知**；
                        mirror 不得做任何猜测；不得声称"canonical 一定没增加"
```

**MUST（两类都必须成立）**：

```
TELEMETRY_FAIL_CLOSED = 可确认的 mutation 未成功时，canonical 与 mirror 都不增加（不乐观 +1）
TURN_FAIL_OPEN        = activation failure 绝不改变 conversation / recall 的结果
```

**R2-H3 冻结（retry / idempotency）**：

```
AUTO_RETRY = NONE
ENDPOINT_SEMANTICS = NON-IDEMPOTENT MUTATION
CALLER MUST NOT AUTO-RETRY
IDEMPOTENCY_SCOPE = NOT PROVIDED（durable/process 幂等移入 FUTURE debt）
```

- activation mutation 是**累加**语义；在没有可靠 dedupe identity 的前提下，
  `AMBIGUOUS_OUTCOME` **不能**被安全地自动重试（重试可能造成第二次 +1）。
- **不** queue、**不** background replay、**不**引入持久事件表 / revision CAS / 幂等键。
- `AMBIGUOUS_OUTCOME` 下 mirror 保持不动，canonical 的最终值由下一次与 canonical 的
  交互（**hydrate**）纠正。这**不是**事务回滚保证。
- 重复的**显式**请求 = **独立** activation event ⇒ 可以再次 +1（这是被冻结的语义，
  不是缺陷；见 §2.6）。
- **必须**留下可观察的 failure 记账（stat / log）。

### 2.6 Activation endpoint 的非幂等性（R2-H3 冻结）

`POST /memory/activate` 是 **NON-IDEMPOTENT MUTATION**：

| 事实 | 冻结内容 |
|---|---|
| 请求身份 | request payload **不含** 任何 activation-event identity（`ids` / `at` / `delta` 而已；HTTP envelope 也不携带可复用的 client token） |
| 因此 | 同一 `ids` 重复提交 ⇒ **两次独立累加**（不静默去重、不 first-write-wins） |
| caller 义务 | **MUST NOT** 自动重试；重试只能由**人/显式动作**触发，且视为新的 activation event |
| 现有身份面 | Home Node **chat turn** 有稳定身份（`requestId` → `turnId`，由 gateway 的有界 TTL dedupe 保证"同一回合只强化一次"）；但该身份**不**流经 activation 端点，也不适用于 browser 独立发起的 activation |
| 幂等需求 | 见下方"未来可选路径"——**不**一律要求 durable state |

> 本节的"不实现幂等"是**有意的**决定，而不是遗漏：在缺少稳定 identity 时实现
> "看起来幂等"的机制（随机 UUID、收到请求后再生成 key、时间戳、ids+at 哈希）
> **不算**幂等，只会制造虚假保证。

**未来可选路径（精确区分，不要混为一谈）**：

| 目标 | 需要什么 | 现状 |
|---|---|---|
| **先设计 stable retry identity** | 一个 client 生成、retry 可复用、服务端可见的 activation-event 身份 | **CURRENT 不存在**（这是任何幂等方案的第一步，且它本身不需要 schema） |
| **PROCESS-LIFETIME 幂等** | 上述 identity **＋** 有界的内存 dedupe（可复用仓库已有的 TTL/容量淘汰形状） | **当前没有设计、也没有实现**；**理论上不需要 schema**（但也**不**在 R2-H 范围内） |
| **CROSS-RESTART exactly-once** | 上述两者 **＋** durable dedupe authority / 持久状态 | **需要 schema**；明确超出 R2-H 冻结范围 |

> 因此**不得**把本节读成"任何未来的 activation 幂等都必须引入 durable schema" ——
> 前两行都不需要；只有**跨重启 exactly-once** 才需要。

### 2.7 Final activation authority matrix（R2-H 收口 · 唯一权威表）

> 这是 activation authority 的**最终矩阵**。其它文档只**引用**它，不另行维护第二张表。

| Operation | Authority | Write destination | Mirror effect | Revision / change-log effect | Failure semantics |
|---|---|---|---|---|---|
| **browser canonical activation** | **Home Node**（唯一 canonical durable authority） | `POST /memory/activate` → `memory-store.recordActivation`（canonical SQLite 两列） | canonical **成功后**才允许：用响应里的权威 per-id 值 **SET**；拿不到权威值 ⇒ 保持 stale（**不猜 delta**） | `revisionTouched=false`；**不**写 change_log；**不**动 `updated_at` | `DEFINITE_FAILURE` ⇒ 两侧都不增加；`AMBIGUOUS_OUTCOME` ⇒ canonical 状态对 caller **未知**、mirror 不猜、**不**自动重试；turn 始终 **fail-open** |
| **HN internal activation** | Home Node（同一写者，不经 HTTP） | `memory-retrieval.reinforce` → `memory-store.recordActivation` | 无（HN 侧无 mirror） | 同上（窄双列 UPDATE） | 失败只记账，绝不抛出、绝不阻塞回合 |
| **mirror mode activation** | **无 canonical authority 生效** | browser IndexedDB `memories`（host-local） | 本地 bump（NON-CANONICAL / HOST-LOCAL） | 与 canonical 无关 | 本地失败只吞掉；**不**调 remote |
| **off mode activation** | 同上（沿用既有 mode 语义） | 同上 | 同上 | 同上 | 同上 |
| **hydrate** | Home Node（来源） | — | **整表 replace**（无 merge）；canonical 值**覆盖** mirror = 合法 authority correction | 由 cursor/revision 驱动，与 activation 无关 | 失败 ⇒ offline/degraded，不改 mirror |
| **changes(cursor)** | Home Node（来源） | — | upserts + deletes | 只承载内容变更 | activation **不在**其中（不产生同步流量） |
| **retry** | — | — | — | — | `AUTO_RETRY = NONE`；endpoint 是 **NON-IDEMPOTENT MUTATION**；重复显式请求 = 独立事件（可再次 +1） |

### 2.4 Home Node 内部 recall activation

Home Node 自身的 recall activation（`memory-retrieval.reinforce` →
`memory-store.recordActivation`）**直接写 canonical SQLite**，已符合单写者语义。

**MUST NOT**：不得为了"所有调用都走 HTTP endpoint"而重构 Home Node 内部路径。
（`/memory/activate` 是**给 browser 用的** canonical 入口，不是内部调用的必经之路。）

### 2.5 mirror mode / off mode 下的 activation

沿用 §3 的既有模式语义，本 contract **不发明新行为**：

| mode | activation 归属 |
|---|---|
| `canonical` | Home Node = canonical authority（§2.1–§2.4） |
| `mirror` | 无 canonical authority 生效；browser 本地 activation telemetry 可用，但必须视为 **NON-CANONICAL / HOST-LOCAL**。**不承诺**切回 canonical 后该 telemetry 会被自动合并进 Home Node |
| `off` | 与 `mirror` 同：authority 已禁用，本地 telemetry 是 NON-CANONICAL / HOST-LOCAL |

> **未定义（R2-H **不**覆盖，非 authority 缺口）**：`mirror` / `off` 模式下的 host-local
> activation 在切回 `canonical` 时的处置（保留 / 丢弃 / 显式回填）**当前未定义**。
> 本 contract 只做上述"不得承诺自动合并"的负向冻结；正向策略留给后续阶段，**不在此猜测**。
> 这不影响 `R2-H ACTIVATION AUTHORITY` 的闭合 —— canonical mode 的 ownership 是唯一被冻结的对象。

---

## 3. 模式

| 模式 | 含义 |
| --- | --- |
| `canonical` | **默认。** Home Node 是 authority；写入 remote-first 且 fail closed。 |
| `mirror` | Legacy rollback 模式；browser 读取/写入 mirror。 |
| `off` | Authority 已禁用；读取/probing 时行为等同 mirror。 |

`MODES = ['canonical','mirror','off']`，默认 `canonical`（`assets/js/memory-authority.js`）。
`file://` origin 无法访问 Home Node，处于 degraded 状态（它不能是 canonical）。

---

## 4. 读取装饰

读取在本地提供，但会带上其 provenance 装饰：`authority:'home-node'` 以及 `readFrom`
值 `mirror`、`mirror-cold` 或 `mirror-degraded`。读取 mirror 与读取
canonical state 并不相同，装饰明确了这一点。

---

## 5. Non-goals

本 contract 不固定 retrieval scoring、consolidation decisions、UI rendering 或 record
字段列表。它在任何 mode 下都不会让 browser mirror 成为 durable authority。

激活相关的非目标（R2-H1 明确）：

- **不**引入 activation field merge / reconciliation（§2.1 的 remote-first 顺序取代了它）；
- **不**把 activation 写进 `memory_change_log`，也不让它推动 revision（见 `MEMORY_RECORD_CONTRACT.md` §5）；
- **不**引入 durable cooldown / exposure 字段（仍为 FUTURE，与本 decision 无关）；
- **不**引入 activation 的持久队列、自动重试或幂等键（归 R2-H3）。

---

## 6. Enforcement

| 测试 | 约束内容 |
| --- | --- |
| `tests/test_memory_authority.js` | modes、write order、fail-closed、watermark、degraded reasons |
| **`tests/test_memory_activation_authority.js`** | **§2.1–§2.5**：canonical activation remote-first、failure atomicity、mirror/cache 边界、HN 单写者形态、hydrate canonical-wins、activation 不进 change_log |
| `tests/test_mobile_memory_read_boundary.js` | device 无法访问 memory |
| `tests/test_mobile_memory_continuity.js` | browser/Node retrieval 一致性 |

---

## 7. 历史起源

`docs/HOME_NODE_CHAT.md §15`（M1-C.2d Wave 2）。历史演进：
`docs/history/runtime/CONTEXT-CONVERGENCE-C1-REPORT.md`。
