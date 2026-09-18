# Role Letter Contract（角色私信契约）

**Status: Canonical**
**Scope: AI ↔ AI Role Letters**

> 当前状态契约。来源：`assets/js/role-letters.js`、`assets/js/active-diary.js`、
> `tests/test_role_letters.js`。

---

## 1. 定义

Role Letter 是**角色与角色之间**交换的私密书信，由角色模型生成，异步、受节流、fail-open。

---

## 2. 存储

| 存储 | 用途 |
| --- | --- |
| IndexedDB `roleLetters`（含 `byTo` / `byFrom` 索引） | 书信本体，**唯一持久化来源** |
| IndexedDB `roleLetterMemories`（owner = `characterId`） | 角色私信长期私有记忆（见 `ROLE_LETTER_MEMORY_CONTRACT.md`） |
| localStorage `ib_role_letters_state_v1` | 每角色 `{ nextInitAt, lastInitAt, nextReplyAt, lastReplyAt, claim… }` |
| localStorage `ib_role_letters_pair_v1` | 角色对 ↔ 上次通信时间（冷却） |
| localStorage `ib_role_letters_replyq_v1` | 每收信角色 `{ letterId, dueAt }` 回复队列 |
| localStorage `ib_role_letters_prefs_v1` | 总开关 |

无 Home Node、无 revision、无 cursor、无 sync。

---

## 3. 生成

- 使用 `callApiChat`（`_ibConsumer:'role_letters'`，jsonMode），**角色模型**执行；
- 由浏览器 `_activeTick`（30s）经 `active-diary.js` 的 `_roleLettersTick` 驱动；
- 上下文来自 `_momentsContext`（角色设定 / 关系 / 聊天摘要 / Memory / 好友动态），可复用；
- 仅从发送方视角生成：A 的 tick 只产生 “我给 B 写了…”，B 的阅读发生在 B 自己的 tick。

---

## 4. 生命周期与节流

- initiate：每角色每天约 1 封；
- pair 冷却：同一对角色 24–72h（`RL_PAIR_KEY`）；
- reply：收到信后进入回复队列，延迟 1–6h；
- read state：`roleLetters.readAt`（未读为 `null`）；
- 候选选择：`pairAffinity`（`_momentsPairAffinity`）作为**权重**；
- fail-open：失败只记录并退避，不影响聊天 / Moments / 日记 / Memory。

---

## 5. 隐私

私信按 `viewAs` 隔离：`toRoleId === viewAs`（收件）或 `fromRoleId === viewAs`（寄件）才展示；其他角色不可见。

---

## 6. 边界

```text
Role Letter ≠ Chat   ≠ Memory(共享)   ≠ Moments feed   ≠ Relationship authority   ≠ Companion
```

- 关系：仅用 `pairAffinity` 选候选，不写 relationship authority；
- Disclosure：0 引用，NOT CURRENTLY ENFORCED；
- Companion：tick 在浏览器，不在后台 Active service；Companion 不拥有 Role Letters。

---

## 7. Enforcement

| 测试 | 约束 |
| --- | --- |
| `tests/test_role_letters.js` | recipientId 编码；不污染共享 `memories`；仅发送方视角；`readAt` 未读；pair 冷却 |

---

## 8. Historical Origin

`assets/js/role-letters.js`。
