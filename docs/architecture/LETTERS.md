# Letters 架构（Letters Architecture）

**Status: Canonical**
**Scope: 当前 Letters 架构与 authority**

> 本文描述 InternalBeyond 当前真实的 Letters runtime。取信顺序：生产代码 → 既有 targeted 测试 →
> 既有 contracts → D10-0 审计 → 当前 canonical 文档 / `DECISIONS.md` → 历史文档。
> 若本文与当前代码冲突，以代码为准。

---

## 1. 定义

Letters 是 InternalBeyond 的**私密书信 surface**。它由**两个彼此独立的 surface**组成：

```text
Letters（领域概念）
├── User ↔ Character Letters   （用户写给角色；用户创作）
└── AI ↔ AI Role Letters        （角色之间通信；模型生成）
```

两者属于同一领域概念，但**不是同一个生命周期、不是同一个存储、也不是同一个 authority**。

明确边界：

```text
Letters ≠ Chat
Letters ≠ Memory
Letters ≠ Moments
Letters ≠ Relationship
Letters ≠ Companion
```

**User Letter ≠ Role Letter**：禁止把两者合并为单一 “Letters subsystem”。

---

## 2. 两类 Letters

### 2.1 User ↔ Character Letters

- 实现：`assets/js/communication/letters.js`
- 存储：浏览器 IndexedDB store `letters`（browser-local）
- 创作：**用户**通过 compose UI 编写；首次加载会 seed 一封 demo letter（`__demo_847__`），删除通过
  `__demo_deleted__` flag 持久化
- 读取：Letters UI（`loadLetters`），按 `created` 排序
- 生成：**未发现角色模型生成路径**（`letters.js` 不调用 `callApiChat`）
- 与 Chat / Memory / Relationship：未发现写入 chat、Memory 或 relationship 的路径

### 2.2 AI ↔ AI Role Letters

- 实现：`assets/js/role-letters.js`
- 存储：
  - `roleLetters`（IndexedDB，含 `byTo` / `byFrom` 索引）——书信本体，唯一持久化来源
  - `roleLetterMemories`（IndexedDB，owner = `characterId`）——角色私信的**长期私有记忆**
  - localStorage：`ib_role_letters_state_v1` / `ib_role_letters_pair_v1` / `ib_role_letters_replyq_v1` /
    `ib_role_letters_prefs_v1`（cadence / 冷却 / 回复队列 / 开关）
- 生成：`callApiChat`（`_ibConsumer:'role_letters'`，jsonMode），使用**角色模型**；由浏览器
  `_activeTick`（30s）经 `active-diary.js` 的 `_roleLettersTick` 驱动
- cadence：每角色每天约 1 封；同一对角色 24–72h 冷却；回复延迟 1–6h（`RL_REPLYQ_KEY`）
- read state：`roleLetters.readAt`（未读为 `null`）
- 候选选择：使用 `pairAffinity`（`_momentsPairAffinity`）作为**选择权重**，不写入 relationship
- fail-open：任何失败只记录并退避，不影响聊天 / Moments / 日记 / Memory
- 私有隔离：信件按 `viewAs`（`toRoleId` / `fromRoleId`）渲染，A 的 tick 只从 A 的视角生成

---

## 3. Authority

| 能力 | Owner |
| --- | --- |
| User Letter 创建 | 用户（`communication/letters.js`） |
| User Letter 存储 | `communication/letters.js`（store `letters`） |
| User Letter 读取 | Letters UI |
| User Letter 删除 | `communication/letters.js`（含 demo flag） |
| Role Letter 创建 | `role-letters.js`（角色模型生成） |
| Role Letter 存储 | `role-letters.js`（store `roleLetters`） |
| Role Letter 读取 | `role-letters.js`（readAt / UI） |
| Role Letter 生命周期（cadence / cooldown / reply queue） | `role-letters.js` |
| Role Letter 私有记忆 | `role-letters.js`（store `roleLetterMemories`，owner = `characterId`） |

两个 surface 各自拥有自己的存储与生命周期；没有跨 surface 的统一 authority。

---

## 4. Storage Boundary

`roleLetterMemories` **≠** Memory subsystem：

- 它是**独立的 IndexedDB store**（owner = `characterId`），不是 `memories`；
- 它有**独立的生命周期**（由 `role-letters.js` 管理与读取）；
- 它**不写进共享 `memories`**——`_rlCleanupLegacyMemories` 会清理历史 `source==='role_letter'` 的
  共享 Memory 记录，证明确实避免污染；
- 它**不受 Memory authority 管理**（无 Home Node、无 revision、无 memory 迁移/固化）。

Letters 当前是 **browser-local 存储**：没有 Home Node letters / `roleLetters` 表、没有 revision、没有
cursor、没有 sync、没有 server storage。

### 4.1 另注：bridge `/api/letters`（记录，非本域 canonical surface）

审计期间发现还存在一个 **bridge 托管的 letters list**：`bridge/routes.js` 暴露 `GET/POST/DELETE
/api/letters`，由 `services/ib-bridge-service.js` 的 `letters` list（记录形状
`{id,to,from,content,reply_to,read,created}`）持久化到 bridge DATA_DIR；`services/home-node/http.js`
的 `doesNotExpose` 显式排除 `letters`。**未发现任何第一方 browser / service consumer 调用该端点。**
本阶段将其记录为「bridge 侧 legacy/parallel 存储，疑似无当前 consumer」的 **DOC GAP / 待后续专项审计**，
不把它并入上述两个 surface，也不修改它。

---

## 5. Memory Boundary

引用：[`MEMORY.md`](MEMORY.md) 与 [`../contracts/memory/`](../contracts/memory/)。

Letters 可以保存长期信息（尤其 `roleLetterMemories`），但这**不代表**它属于 Memory subsystem：

- Memory 拥有 canonical lifecycle；Letters 不拥有；
- Letters 不 hydrate / 不 consolidate / 不写入共享 `memories`；
- Memory authority 继续属于 Memory subsystem。

```text
Letters ≠ Memory
Letters ⊄ Memory
```

---

## 6. Moments / Social Boundary

Letters **没有** feed、没有 social ACL（`visibility` / `visibleRoleIds`）、没有 Moments ownership。
Role Letters 会**读取** Moments context（`_momentsContext` / `getRoleMoments`）作为一个上下文块，但
不会被发布到 Moments feed，也不进入 Social 社交图 / 回复链。

```text
Social content ≠ Private letter
```

参见 [`MOMENTS.md`](MOMENTS.md) 与 [`../SOCIAL_RUNTIME.md`](../SOCIAL_RUNTIME.md)。

---

## 7. Relationship Boundary

Letters **可以影响互动、可以作为上下文**，但：

```text
Letter event ≠ Relationship authority
```

`cfg.relationship` 仍是 relationship authority（见 [`COMPANION.md`](COMPANION.md) 与
[`../contracts/companion/RELATIONSHIP_AUTHORITY_CONTRACT.md`](../contracts/companion/RELATIONSHIP_AUTHORITY_CONTRACT.md)）。
Role Letters 仅用 `pairAffinity` 做候选选择，**不持久化关系权威**，也不写 `disclosureFacts`。

---

## 8. Disclosure Boundary

当前事实（见 [`DISCLOSURE.md`](DISCLOSURE.md)）：

```text
Disclosure integration:
NOT CURRENTLY ENFORCED
```

`role-letters.js` / `letters.js` 对 disclosure 有 **0** 引用。Letters 不创建 disclosure fact、不携带
secret、不触发 `authorize()`、也不被 disclosure gate。不要提前设计或假设接入。

---

## 9. Companion Boundary

```text
Companion does not own Letters
```

Role Letters 的 tick 运行在**浏览器**（`_activeTick` → `_roleLettersTick`），不在后台 Active service
（`active/` 无 role-letters）。Companion 既不生成也不拥有 Letters。

---

## 10. Provider / Model Boundary

Letters 使用**角色模型执行能力**（`callApiChat`，`_ibConsumer:'role_letters'`）。不存在独立的
`Letters provider`；共享执行端口（`callApiChat` / ModelPort）是执行抽象，不是 provider authority。

---

## 11. UI Boundary

Letters UI 负责**展示 / 编写 / 管理**（list / compose / archive / display）。UI 是 surface，不是
storage、不是 authority。

---

## 12. Non-goals

Letters 不拥有：Chat、Memory、Moments、Relationship、Disclosure、Companion。它不定义统一的
Letters runtime，也不引入新存储 / 新同步 / 新迁移。

---

## 13. Enforcement

| 关注点 | 测试 |
| --- | --- |
| Role Letters（recipientId 编码 / 不污染共享 `memories` / 仅发送方视角 / readAt / pair 冷却） | `tests/test_role_letters.js` |
| User Letters | 未发现专项测试 |

Runtime 行为由上述测试强制；本文档是人类 canonical authority。

---

## 14. Historical References

Provenance only：`docs/DECISIONS.md` 中的 letters 相关记录；P11/P23 阶段记录。历史文档不再承担
current authority。
