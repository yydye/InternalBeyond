# Memory Record Contract

**Status: Canonical**
**Scope: canonical memory record 对象**

> memory record 的当前状态 contract：字段、content 与 telemetry 的分离、identity、
> ownership 以及 structural validation。派生自 `assets/js/memory-contract.js`；它不虚构
> 字段，也不扩充现有 vocabulary。

---

## 1. Record 形状

一条 memory record 是以 `payload_json` 原样持久化的 JSON 对象，其中少量字段
被提升为查询列。

| 分组 | Fields | 说明 |
| --- | --- | --- |
| 身份 | `id` | 主键（`record_id`）；必填、非空、≤ 200 字符 |
| 内容 | `title`, `summary`, `content` | 人类可见文本 |
| 分类 | `domain`, `category`, `tags[]`, `kind` | `kind` → 提升为 `class`（默认 `episodic`） |
| 情感 | `valence` (0–1), `arousal` (0–1) | scoring 输入 |
| 权重 | `importance` (1–10), `resolved`, `pinned` | scoring / decay |
| 归属 | `createdBy`, `createdByName` | `owner_id` 派生自 `createdBy` |
| Visibility (ACL) | `visibility`, `visibleTo[]`, `excludeFrom[]` | 为 pre-filter 而提升 |
| 来源 | `source`, `sourceId`, `consolidatedFrom` | producer / consolidation |
| 时间戳 | `created` (or `createdAt`) | identity，不可编辑 |
| 遥测 | `activationCount`, `lastActivated`, `lastConsolidatedAt`, `visibilityRepairedAt`, `visibilityRepairReason` | 见 §3 |

未知字段必须通过 `payload_json` 原样往返。

---

## 2. Content 与 Telemetry

- **Content** 影响 `contentFingerprint`（剥离 telemetry 后对 record 的 stable stringify）。
- **Telemetry 不影响 fingerprint。** `TELEMETRY_FIELDS`（`memory-contract.js`）为：
  `activationCount`, `lastActivated`, `lastConsolidatedAt`, `visibilityRepairedAt`,
  `visibilityRepairReason`.

为什么重要：activation 每个 turn 都会变化；如果它参与 equivalence，migration 重跑
会把所有内容归类为 `updated`，破坏 idempotency。Telemetry 仅从
**equivalence comparison** 中排除——它仍会存储在 payload 中。

`contentIdentical(a, b)` 定义为 fingerprint 相等。

---

## 3. 归属

`owner_id` 是 canonical partition key，由 `ownerIdOf(record)` 从 `createdBy` 派生，默认为
`'user'`。它是 partition key，**不是** ACL。ACL 是 `visibility` / `visibleTo` / `excludeFrom`。

---

## 4. 结构校验

`validateRecord(record)` 只拒绝 Home Node 无法安全存储的内容：

- 不是对象 → `not-an-object`；
- `id` 缺失/为空 → `missing-id`；`id` 超过 200 → `id-too-long`；
- `visibility` 存在但不是字符串 → `visibility-not-a-string`；
- `visibleTo` / `excludeFrom` 存在但不是数组 → `visibleTo-not-an-array` / `excludeFrom-not-an-array`。

`visibility` **刻意不做语义校验**：缺失或格式错误的 `visibility` 必须
原样存储，因为 fail-closed visibility 规则依赖于“缺失保持缺失”。将
缺失的 visibility 强制转换为 `'public'` 会把一条不可见的 memory 变成 public。

---

## 5. Promoted Columns 与 Payload

Home Node 表为 query/ACL/ranking 提升 `owner_id`、`class`、`visibility`、`visible_to`、`exclude_from`、
`importance`、`pinned`、`activation_count`、`last_activated_at`、timestamps 与 `revision`。
`payload_json` 持有**每一个**字段。Activation 是一次双列 `UPDATE`
（`activation_count`, `last_activated_at`），既不触碰 `payload_json` 也不触碰 `revision`。

---

## 6. Non-goals

本 contract 不固定 retrieval scoring、ranking weights 或 UI rendering。它不添加字段，
也不改变 vocabulary。

---

## 7. Enforcement

| 测试 | 约束内容 |
| --- | --- |
| `tests/test_memory_contract_closure.js` | fingerprint、telemetry 排除、validation、owner/class |
| `tests/test_memory_migration.js` | content-identical ⇒ idempotent migration |

---

## 8. 历史起源

`assets/js/memory-contract.js`（M1-C.2d Wave 2）。pre-authority 字段叙述：`docs/MEMORY.md §1`。
