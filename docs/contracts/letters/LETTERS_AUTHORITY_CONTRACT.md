# Letters Authority Contract（Letters authority 契约）

**Status: Canonical**
**Scope: Letters 两个 surface 的 owner、生命周期与边界**

> 当前状态契约。来源：`assets/js/communication/letters.js`、`assets/js/role-letters.js`、
> `tests/test_role_letters.js`。详细字段见三个子契约。

---

## 1. 两个 surface

```text
User ↔ Character Letters   →  communication/letters.js  （store `letters`）
AI ↔ AI Role Letters        →  role-letters.js           （stores `roleLetters` + `roleLetterMemories`）
```

两者各自拥有独立 storage / lifecycle / authority。**User Letter ≠ Role Letter**，不得合并。

---

## 2. Owner

| 能力 | Owner |
| --- | --- |
| User Letter 创建 / 存储 / 读取 / 删除 | `communication/letters.js`（用户创作；demo flag） |
| Role Letter 创建 / 存储 / 读取 | `role-letters.js`（角色模型生成） |
| Role Letter 生命周期（cadence / cooldown / reply queue / readAt） | `role-letters.js` |
| Role Letter 私有记忆 | `role-letters.js`（`roleLetterMemories`，owner = `characterId`） |

---

## 3. Lifecycle

- **User Letter**：创建 → 列出（按 `created` 排序）→ 删除；demo letter 通过 `__demo_deleted__`
  flag 持久化删除状态。
- **Role Letter**：initiate（每角色每天约 1 封）→ pair 冷却（24–72h）→ reply 队列（延迟 1–6h）→
  `readAt` 未读标记；全部 fail-open。

---

## 4. Boundaries

```text
Letters ≠ Chat        Letters ≠ Memory     Letters ≠ Moments
Letters ≠ Relationship   Letters ≠ Companion
```

- `roleLetterMemories ≠ Memory subsystem`（独立 store；见 `ROLE_LETTER_MEMORY_CONTRACT.md`）；
- 没有 feed / social ACL / Moments ownership；
- relationship authority 属于 `cfg.relationship`（Letter event ≠ Relationship authority）；
- Disclosure 集成：**NOT CURRENTLY ENFORCED**；
- Companion 不拥有 Letters（浏览器 tick，不在后台 Active service）；
- 无 Letters provider（使用角色模型 `callApiChat`）。

---

## 5. Non-goals

不定义统一 Letters runtime、不新增存储/同步/迁移、不接入 Disclosure/Memory/Companion。

---

## 6. Enforcement

| 测试 | 约束 |
| --- | --- |
| `tests/test_role_letters.js` | recipientId 编码、不污染共享 `memories`、仅发送方视角、readAt、pair 冷却 |

---

## 7. Historical Origin

`assets/js/communication/letters.js`；`assets/js/role-letters.js`。
