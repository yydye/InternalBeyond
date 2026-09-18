# Role Letter Memory Contract（角色私信私有记忆契约）

**Status: Canonical**
**Scope: `roleLetterMemories` 存储及其与 Memory subsystem 的区别**

> 当前状态契约。来源：`assets/js/role-letters.js`、`tests/test_role_letters.js`。

---

## 1. 定义

`roleLetterMemories` 是 Role Letters 的**专用私有记忆 store**（owner = `characterId`）。它保存角色私信的长期信息，但**不属于** Memory subsystem。

```text
roleLetterMemories ≠ Memory subsystem
```

---

## 2. 存储

| 方面 | 值 |
| --- | --- |
| 存储 | IndexedDB store `roleLetterMemories`（browser-local） |
| owner | `characterId` |
| 写入 | `role-letters.js`（`dbPut(RL_MEM_STORE, mem)`） |
| 读取 | `role-letters.js`；`moments.js` / `active-diary.js` 上下文块（`_rlMemoriesFor` / `_rlMemBlock`）；`agent-runtime.js` 上下文类型 |

无 Home Node、无 revision、无 cursor、无 memory 迁移/固化。

---

## 3. 为什么不属于 Memory subsystem

- **独立 store**：不是共享 `memories`；
- **独立生命周期**：由 `role-letters.js` 管理与读取，非 Memory authority；
- **不进入 `memories`**：`_rlCleanupLegacyMemories` 会清理历史 `source==='role_letter'` 的共享
  Memory 记录，明确避免污染 Memory 面板 / export / backup / 统计；
- **不受 Memory authority 管理**：无 canonical/mirror/off、无 Memory 固化流程。

---

## 4. 边界

```text
Role Letter Memory ⊄ Memory subsystem
```

引用 [`../../architecture/MEMORY.md`](../../architecture/MEMORY.md) 与
[`../memory/`](../memory/)：Memory authority 继续属于 Memory subsystem。

---

## 5. Non-goals

不定义 Memory 生命周期、不做 consolidation、不进入 Memory export / backup。

---

## 6. Enforcement

| 测试 | 约束 |
| --- | --- |
| `tests/test_role_letters.js` | 私有记忆写 `roleLetterMemories`；共享 `memories` 无 role-letter 污染；初始化无历史污染 |

---

## 7. Historical Origin

`assets/js/role-letters.js`（core.js 引入 `roleLetterMemories` 时起）。
