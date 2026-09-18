# User Letter Contract（用户书信契约）

**Status: Canonical**
**Scope: User ↔ Character Letters**

> 当前状态契约。来源：`assets/js/communication/letters.js`。

---

## 1. 定义

User Letter 是**用户写给角色**的私密书信，由用户创作并保存在浏览器本地。

---

## 2. 存储

| 方面 | 值 |
| --- | --- |
| 存储 | IndexedDB store `letters`（browser-local） |
| keyPath | `id` |
| 排序 | 按 `created` 倒序 |
| demo | seed id `__demo_847__`；删除 flag `__demo_deleted__` |

无 Home Node、无 revision、无 cursor、无 sync、无迁移。

---

## 3. 生命周期

- **创建**：用户通过 compose UI 写入；首次加载 seed demo letter。
- **读取**：Letters UI（`loadLetters`）。
- **删除**：`dbDelete('letters', id)`；demo 通过 flag 持久化删除。
- **生成**：**未发现角色模型生成路径**（不调用 `callApiChat`）。

---

## 4. 边界

```text
User Letter ≠ Chat   ≠ Memory   ≠ Moments   ≠ Relationship   ≠ Companion
```

- 未发现写入 chat store / Memory / relationship 的路径；
- 不参与 feed / social ACL；
- 不受 Disclosure gate（Disclosure 集成 NOT CURRENTLY ENFORCED）。

---

## 5. Non-goals

不定义模型生成、不定义 Memory/relationship 写入、不定义同步。

---

## 6. Enforcement

未发现 User Letter 专项测试（记录为测试缺口，不新增）。

---

## 7. Historical Origin

`assets/js/communication/letters.js`。
